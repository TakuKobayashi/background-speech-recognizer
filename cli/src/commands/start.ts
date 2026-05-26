import * as path from 'path';
import * as fs from 'fs';

import { VoiceRecorder, RecorderEvent, RecordingSession } from '../recorder';
import { VadMode } from '../vad';
import { SessionQueue } from '../queue';
import { HealthMonitor } from '../health';
import { logger } from '../logger';
import { trySetRawMode, getDefaultWhisperBin, checkAudioDependency } from '../platform';
import {
  getTimestamp,
  ensureOutputDir,
  writeWav,
  writeTxt,
  formatDuration,
} from '../utils';
import { TranscriberPool } from '../worker/transcriber-pool';

export interface StartOptions {
  model?:       string;
  whisperBin?:  string;
  language?:    string;
  output?:      string;
  vad?:         string;
  threads?:     string;
  queueSize?:   string;
  concurrency?: string;
  device?:      string;
}

const USE_COLOR = process.env.NO_COLOR === undefined && process.stdout.isTTY;
const C = {
  reset:  USE_COLOR ? '\x1b[0m'  : '',
  bold:   USE_COLOR ? '\x1b[1m'  : '',
  dim:    USE_COLOR ? '\x1b[2m'  : '',
  red:    USE_COLOR ? '\x1b[31m' : '',
  green:  USE_COLOR ? '\x1b[32m' : '',
  yellow: USE_COLOR ? '\x1b[33m' : '',
  blue:   USE_COLOR ? '\x1b[34m' : '',
  cyan:   USE_COLOR ? '\x1b[36m' : '',
  white:  USE_COLOR ? '\x1b[37m' : '',
};

function logLine(msg: string): void {
  process.stdout.write(msg + '\n');
}

export async function runStart(opts: StartOptions): Promise<void> {
  const config = {
    whisperBin: opts.whisperBin ?? process.env.WHISPER_BIN  ?? getDefaultWhisperBin(),
    modelPath:  opts.model      ?? process.env.WHISPER_MODEL ?? './models/ggml-base.bin',
    language:   opts.language   ?? process.env.WHISPER_LANG  ?? 'ja',
    outputDir:  opts.output     ?? process.env.OUTPUT_DIR    ?? './outputs',
    vadMode:    parseInt(opts.vad ?? process.env.VAD_MODE ?? '2') as VadMode,
    threads:    opts.threads ? parseInt(opts.threads)
                : (process.env.WHISPER_THREADS ? parseInt(process.env.WHISPER_THREADS) : undefined),
    queueSize:  parseInt(opts.queueSize   ?? process.env.QUEUE_SIZE   ?? '8'),
    concurrency:parseInt(opts.concurrency ?? process.env.WORKER_CONCURRENCY ?? '1'),
    deviceId:   opts.device ?? process.env.MIC_DEVICE,
  } as const;

  const audioCheck = checkAudioDependency();
  if (!audioCheck.ok) {
    logger.error(audioCheck.message);
    logLine(`${C.red}❌ ${audioCheck.message}${C.reset}`);
    process.exit(1);
  }
  if (!fs.existsSync(config.modelPath)) {
    logLine(`${C.red}❌ モデルが見つかりません: ${config.modelPath}${C.reset}`);
    logLine(`${C.yellow}   → npm run download-model -- base でダウンロードできます${C.reset}`);
    process.exit(1);
  }
  if (!fs.existsSync(config.whisperBin)) {
    logLine(`${C.red}❌ whisper.cpp バイナリが見つかりません: ${config.whisperBin}${C.reset}`);
    logLine(`${C.yellow}   → npm run doctor で診断できます${C.reset}`);
    process.exit(1);
  }

  ensureOutputDir(config.outputDir);
  printHeader(config);

  const health = new HealthMonitor();
  health.on('critical', () => {
    logger.error('[Main] メモリ緊急しきい値超過 — 再起動を推奨');
  });
  health.start();

  const pool = new TranscriberPool({
    whisperBin: config.whisperBin,
    modelPath:  config.modelPath,
    language:   config.language,
    ...(config.threads ? { threads: config.threads } : {}),
    concurrency: config.concurrency,
  });

  const queue    = new SessionQueue(config.queueSize);
  const recorder = new VoiceRecorder(config.vadMode);

  let isShuttingDown = false;

  async function shutdown(): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logLine(`\n\n${C.yellow}🛑 シャットダウン中...${C.reset}`);
    logger.info('[Main] シャットダウン開始');

    recorder.stop();
    health.stop();
    queue.clear();
    await pool.shutdown();

    const s = health.getStatus();
    logLine(`\n${C.cyan}═══ 終了統計 ═══${C.reset}`);
    logLine(`  稼働時間      : ${formatDuration(s.uptimeSeconds)}`);
    logLine(`  文字起こし数  : ${s.transcriptions}`);
    logLine(`  エラー数      : ${s.errors}`);
    logLine(`  ドロップ数    : ${s.droppedSessions}`);
    logLine(`  マイク再接続  : ${s.micRestarts}`);
    logLine(`  ヒープ使用    : ${s.heapUsedMb} MB`);
    logLine(`${C.cyan}════════════════${C.reset}`);
    logLine(`${C.green}✅ 正常終了${C.reset}`);
    logger.info(`[Main] 正常終了 tx=${s.transcriptions} err=${s.errors}`);

    process.exit(0);
  }

  process.on('unhandledRejection', (reason) => {
    logger.error(`[unhandledRejection] ${String(reason)}`);
    health.recordError();
  });
  process.on('uncaughtException', (err) => {
    logger.error(`[uncaughtException] ${err.message}\n${err.stack ?? ''}`);
    health.recordError();
    if (err.message.includes('ENOMEM') || err.message.includes('Out of memory')) {
      logger.error('メモリ不足による緊急終了');
      void shutdown();
    }
  });
  process.on('SIGINT',  () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  if (trySetRawMode(process.stdin)) {
    process.stdin.on('keypress', (_, key: { ctrl?: boolean; name?: string } | undefined) => {
      if (key?.ctrl && key.name === 'c') { void shutdown(); }
    });
  }

  // ===== ディスパッチャ：Queue → Pool =====
  // SessionQueue から取り出して Worker Pool に投げ、戻り値が来たらファイル化。
  // Pool 側にも内部キューがあるが、SessionQueue で「直近 N 件」のメモリ上限を保つ。
  let dispatcherRunning = false;
  async function runDispatcher(): Promise<void> {
    if (dispatcherRunning) return;
    dispatcherRunning = true;

    while (!queue.isEmpty && !isShuttingDown) {
      const queued = queue.dequeue();
      if (!queued) break;

      const session = queued.session;
      const waitStr = formatDuration(queued.waitMs() / 1000);
      const tag = session.continued ? `📦 中間セグメント#${session.segmentIndex}` : `⏹ 録音終了#${session.segmentIndex}`;
      logLine(`\n${C.blue}${tag} (${formatDuration(session.durationSeconds)}, 待機 ${waitStr})${C.reset}`);

      const timestamp = getTimestamp();
      const wavPath   = path.join(config.outputDir, `${timestamp}_${session.segmentIndex}.wav`);
      const txtPath   = path.join(config.outputDir, `${timestamp}_${session.segmentIndex}.txt`);

      try {
        writeWav(wavPath, session.pcmBuffer);

        const jobId = pool.newJobId();
        // pool.enqueue は await するが、I/O 待ちなので録音は並行継続
        void pool.enqueue({
          jobId,
          pcmBuffer:    session.pcmBuffer,
          savedWavPath: wavPath,
          segmentIndex: session.segmentIndex,
          startedAt:    session.startedAt,
        }).then(async (res) => {
          if (res.ok && res.text) {
            writeTxt(txtPath, res.text);
            health.recordTranscription();
            logLine(`\n${C.green}${C.bold}✅ #${res.segmentIndex} 完了 (${res.durationMs}ms)${C.reset}`);
            logLine(`${C.white}${C.bold}💬 ${res.text}${C.reset}`);
            logLine(`${C.dim}📁 ${wavPath}${C.reset}`);
            logLine(`${C.dim}📄 ${txtPath}${C.reset}`);
            logger.info(`[TX] #${res.segmentIndex} "${res.text.slice(0, 80)}" (${res.durationMs}ms)`);
          } else {
            health.recordError();
            logLine(`\n${C.red}❌ #${res.segmentIndex} 文字起こしエラー: ${res.error}${C.reset}`);
            logger.error(`[TX] #${res.segmentIndex} エラー: ${res.error}`);
            try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch { /* ignore */ }
          }
        });
      } catch (err) {
        health.recordError();
        logLine(`\n${C.red}❌ WAV 書き込み失敗: ${String(err)}${C.reset}`);
        logger.error(`[Dispatch] ${String(err)}`);
      } finally {
        (session as { pcmBuffer?: Buffer }).pcmBuffer = undefined as unknown as Buffer;
      }
    }

    dispatcherRunning = false;
  }

  // ===== レコーダーイベント =====
  recorder.on('event', (evt: RecorderEvent) => {
    if (isShuttingDown) return;

    switch (evt.type) {
      case 'voice_start':
        process.stdout.write(`\n${C.green}${C.bold}🔴 録音中...${C.reset} `);
        logger.debug('[Recorder] 音声検出開始');
        break;

      case 'too_short':
        logLine(`${C.dim}⏭ 短すぎてスキップ (${formatDuration(evt.durationSeconds)})${C.reset}`);
        break;

      case 'voice_segment':
      case 'voice_end': {
        const session: RecordingSession = evt.session;
        const { dropped } = queue.enqueue(session);
        if (dropped) {
          health.recordDropped();
          logger.warn(`[Queue] セッションドロップ (キュー満杯) dur=${formatDuration(dropped.session.durationSeconds)}`);
          logLine(`${C.yellow}⚠ キュー満杯のため古いセッションをドロップ${C.reset}`);
        }
        void runDispatcher();
        break;
      }

      case 'reconnecting':
        health.recordMicRestart();
        logLine(`\n${C.yellow}🔄 マイク再接続中 (試行 ${evt.attempt})...${C.reset}`);
        logger.warn(`[Recorder] マイク再接続 attempt=${evt.attempt}`);
        break;

      case 'level': {
        const bar = Math.max(0, Math.min(20, Math.round((evt.db + 60) / 3)));
        process.stdout.write(
          `\r${C.green}${C.bold}🔴 録音中${C.reset} ` +
          `${C.green}${'█'.repeat(bar)}${C.dim}${'░'.repeat(20 - bar)}${C.reset} ` +
          `${evt.db.toFixed(1)}dB `
        );
        break;
      }

      case 'error':
        health.recordError();
        logLine(`\n${C.red}⚠ マイクエラー: ${evt.error.message}${C.reset}`);
        logger.error(`[Recorder] ${evt.error.message}`);
        break;
    }
  });

  logger.info(`[Main] 起動 bin=${config.whisperBin} model=${config.modelPath} lang=${config.language} concurrency=${config.concurrency}`);
  recorder.start(config.deviceId);
}

function printHeader(config: {
  modelPath: string; language: string; outputDir: string; vadMode: VadMode; concurrency: number;
}): void {
  if (process.stdout.isTTY) console.clear();
  logLine(`${C.bold}${C.cyan}╔════════════════════════════════════════╗${C.reset}`);
  logLine(`${C.bold}${C.cyan}║   🎙️  Whisper Local Transcriber CLI    ║${C.reset}`);
  logLine(`${C.bold}${C.cyan}╚════════════════════════════════════════╝${C.reset}`);
  logLine(`${C.dim}モデル    : ${config.modelPath}${C.reset}`);
  logLine(`${C.dim}言語      : ${config.language}${C.reset}`);
  logLine(`${C.dim}出力      : ${config.outputDir}${C.reset}`);
  logLine(`${C.dim}VAD       : モード ${config.vadMode}${C.reset}`);
  logLine(`${C.dim}並列度    : worker x${config.concurrency}${C.reset}`);
  logLine('');
  logLine(`${C.yellow}▶ マイク待機中... 話しかけてください (Ctrl+C で終了)${C.reset}`);
  logLine(`${C.dim}${'─'.repeat(44)}${C.reset}`);
}
