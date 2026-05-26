import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { tmpRegistry, writeWav } from './utils';
import { killProcess, IS_WINDOWS, makeTmpPath, safeUnlink } from './platform';
import { logger } from './logger';

export interface TranscribeOptions {
  whisperBin:  string;
  modelPath:   string;
  language?:   string;
  threads?:    number;
  timeoutMs?:  number;
}

export interface TranscribeResult {
  text:       string;
  durationMs: number;
  wavPath:    string;
}

/**
 * 実行中の whisper.cpp 子プロセスを追跡するグローバルセット
 * process 終了時に全てを kill する
 */
const activeProcs = new Set<ChildProcess>();

function registerGlobalCleanup(): void {
  const cleanup = () => {
    for (const proc of activeProcs) {
      try {
        if (proc.pid && !proc.killed) killProcess(proc.pid);
      } catch { /* ignore */ }
    }
    activeProcs.clear();
  };
  process.once('exit',    cleanup);
  process.once('SIGINT',  cleanup);
  process.once('SIGTERM', cleanup);
  if (!IS_WINDOWS) {
    process.once('SIGHUP', cleanup);
  }
}
registerGlobalCleanup();

/**
 * whisper.cpp をサブプロセスとして実行するトランスクライバー
 *
 * 修正点:
 * - 子プロセスをグローバルセットで追跡（クラッシュ時もゾンビを防ぐ）
 * - stdout/stderr を Buffer 配列で受け取り（string 結合によるメモリ肥大化を防ぐ）
 * - タイムアウト時 SIGTERM → 猶予後 SIGKILL（Windows は taskkill）
 * - 一時 WAV ファイルを tmpRegistry に登録し exit 時確実削除
 * - Windows 互換：SIGKILL の代わりに killProcess() を使用
 */
export class Transcriber {
  private readonly options: Required<TranscribeOptions>;

  constructor(options: TranscribeOptions) {
    this.options = {
      language:  'ja',
      threads:   Math.max(1, Math.floor(os.cpus().length / 2)),
      timeoutMs: 60_000,
      ...options,
    };
    this.validateSetup();
  }

  private validateSetup(): void {
    if (!fs.existsSync(this.options.whisperBin)) {
      throw new Error(
        `whisper.cpp バイナリが見つかりません: ${this.options.whisperBin}\n` +
        'README の whisper.cpp セットアップ を参照してください。'
      );
    }
    if (!fs.existsSync(this.options.modelPath)) {
      throw new Error(
        `モデルファイルが見つかりません: ${this.options.modelPath}\n` +
        'README のモデルダウンロードを参照してください。'
      );
    }
  }

  /**
   * PCM バッファを一時 WAV ファイルに書いて文字起こし
   */
  async transcribe(wavBuffer: Buffer): Promise<TranscribeResult> {
    const tmpWav = makeTmpPath('wsp', 'wav');
    tmpRegistry.register(tmpWav);
    try {
      writeWav(tmpWav, wavBuffer);
      return await this.transcribeFile(tmpWav);
    } finally {
      safeUnlink(tmpWav);
      tmpRegistry.unregister(tmpWav);
    }
  }

  /**
   * 既存 WAV ファイルを文字起こし
   */
  async transcribeFile(wavPath: string): Promise<TranscribeResult> {
    const startTime = Date.now();

    // whisper.cpp は -of オプションで .txt を生成することがあるため
    // ここでは stdout のみを使用し --output-txt は渡さない
    const args = [
      '-m', this.options.modelPath,
      '-f', wavPath,
      '-l', this.options.language,
      '-t', String(this.options.threads),
      '--no-timestamps',
      '-nt',
    ];

    return new Promise<TranscribeResult>((resolve, reject) => {
      let proc: ChildProcess;

      try {
        proc = spawn(this.options.whisperBin, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          // Windows でも子プロセスグループを作る（taskkill /T 対応）
          detached: IS_WINDOWS ? false : false,
        });
      } catch (err) {
        reject(new Error(`whisper.cpp 起動失敗: ${String(err)}`));
        return;
      }

      activeProcs.add(proc);

      // ===== stdout/stderr を Buffer 配列で蓄積（string 結合を回避） =====
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB 上限
      let stdoutBytes = 0;
      let stderrBytes = 0;

      proc.stdout!.on('data', (d: Buffer) => {
        if (stdoutBytes + d.length <= MAX_OUTPUT_BYTES) {
          stdoutChunks.push(d);
          stdoutBytes += d.length;
        }
      });
      proc.stderr!.on('data', (d: Buffer) => {
        if (stderrBytes + d.length <= MAX_OUTPUT_BYTES) {
          stderrChunks.push(d);
          stderrBytes += d.length;
        }
      });

      // ===== タイムアウト処理 =====
      const timeout = setTimeout(() => {
        if (proc.pid) {
          logger.warn(`[Transcriber] タイムアウト (${this.options.timeoutMs}ms) — プロセス kill`);
          killProcess(proc.pid);
        }
        activeProcs.delete(proc);
        reject(new Error(`whisper.cpp タイムアウト (${this.options.timeoutMs}ms)`));
      }, this.options.timeoutMs);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        activeProcs.delete(proc);
        reject(new Error(`whisper.cpp 起動エラー: ${err.message}`));
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        activeProcs.delete(proc);

        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        // stdoutChunks/stderrChunks を早めに GC 対象にする
        stdoutChunks.length = 0;
        stderrChunks.length = 0;

        if (code !== 0) {
          reject(new Error(
            `whisper.cpp が非ゼロで終了: code=${code}\n` +
            `stderr: ${stderr.slice(0, 200)}`
          ));
          return;
        }

        const text = this.extractText(stdout);
        if (!text.trim()) {
          reject(new Error('文字起こし結果が空でした'));
          return;
        }

        resolve({ text: text.trim(), durationMs: Date.now() - startTime, wavPath });
      });
    });
  }

  /**
   * whisper.cpp stdout からテキスト部分を抽出
   */
  private extractText(output: string): string {
    const lines = output.split('\n');
    const textLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // タイムスタンプ行: "[00:00:00.000 --> 00:00:02.000]  こんにちは"
      if (trimmed.startsWith('[') && trimmed.includes('-->')) {
        const m = trimmed.match(/\]\s+(.+)$/);
        if (m?.[1]) textLines.push(m[1].trim());
        continue;
      }

      // デバッグ出力を除外
      if (
        !trimmed.startsWith('whisper_') &&
        !trimmed.startsWith('system_info') &&
        !trimmed.startsWith('main:') &&
        !trimmed.startsWith('log_mel') &&
        !trimmed.startsWith('ggml_') &&
        !trimmed.match(/^\d+\.\d+%/)
      ) {
        textLines.push(trimmed);
      }
    }

    return textLines.join(' ');
  }
}
