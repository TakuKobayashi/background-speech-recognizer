import * as path from 'path';
import * as fs from 'fs';

import { VoiceRecorder, RecorderEvent, RecordingSession } from '../recorder';
import { VadMode } from '../vad';
import { SessionQueue } from '../queue';
import { HealthMonitor } from '../health';
import { logger } from '../logger';
import {
  getDefaultWhisperBin,
  checkAudioDependency,
  prependVendorBinsToPath,
} from '../platform';
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

/**
 * whisper.cpp の出力から「発話ではない注釈」を取り除く。
 * 例:
 *   (音楽) / (笑) / (拍手)
 *   [Music] / [Laughter] / [BLANK_AUDIO] / [SOUND]
 *   （無音）/【効果音】/ ♪ ♫
 * を消し、残った空白を圧縮した上でトリムする。
 * クリーニング後に空文字になったら呼び出し側で「発話なし」として保存スキップする想定。
 */
function cleanTranscription(raw: string): string {
  return raw
    // 半角 / 全角の丸括弧・角括弧で囲まれた注釈を一律で削除
    .replace(/[(\[（【][^)\]）】]*[)\]）】]/g, '')
    // 楽譜記号
    .replace(/[♪♫♬♩]/g, '')
    // 連続する空白 (全角空白含む) を 1 つに圧縮
    .replace(/[\s　]+/g, ' ')
    .trim();
}

export async function runStart(opts: StartOptions): Promise<void> {
  // setup-whisper で自動 DL された vendor/sox 等を mic ライブラリから見えるようにする
  prependVendorBinsToPath();

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

  let isShuttingDown    = false;
  let shutdownStartedAt = 0;
  const SHUTDOWN_TIMEOUT_MS = 5000;

  async function shutdown(reason: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown    = true;
    shutdownStartedAt = Date.now();

    logLine(`\n\n${C.yellow}🛑 シャットダウン中... (${reason})${C.reset}`);
    logLine(`${C.dim}   もう一度 Ctrl+C を押すと強制終了します${C.reset}`);
    logger.info(`[Main] シャットダウン開始 (${reason})`);

    // どこかで詰まっても確実に落ちるよう、タイマーで強制終了をかける
    const killTimer = setTimeout(() => {
      logLine(`\n${C.red}⚠ シャットダウンが ${SHUTDOWN_TIMEOUT_MS}ms 経っても終わらないので強制終了します${C.reset}`);
      logger.error(`[Main] シャットダウンタイムアウト — process.exit(1)`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    killTimer.unref(); // タイマー自体ではプロセスを生かさない

    try {
      recorder.stop();
      health.stop();
      queue.clear();
      await pool.shutdown();
    } catch (err) {
      logger.error(`[Main] シャットダウン中エラー: ${String(err)}`);
    }
    clearTimeout(killTimer);

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
      void shutdown('out-of-memory');
    }
  });

  // SIGINT を 2 回受けたら強制終了。1 回目は graceful shutdown。
  // stdin を raw mode に入れると SIGINT が抑止されてしまうため、ここではあえて raw mode を使わない。
  process.on('SIGINT', () => {
    if (isShuttingDown) {
      logLine(`\n${C.red}⛔ 強制終了します${C.reset}`);
      logger.warn(`[Main] 2 回目の SIGINT で強制終了 (経過 ${Date.now() - shutdownStartedAt}ms)`);
      process.exit(130);
    }
    void shutdown('Ctrl+C');
  });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  // Windows でターミナルを閉じたときに飛んでくる
  process.on('SIGBREAK', () => { void shutdown('SIGBREAK'); });
  process.on('SIGHUP',   () => { void shutdown('SIGHUP'); });

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

      // ローカルに退避: pool 側は別 ArrayBuffer をコピーして worker に Transferable する仕様
      // (TranscriberPool.dispatch) なので、ここでは元 Buffer を保持し続けて結果が出たら使う。
      const pcmBuffer = session.pcmBuffer;

      try {
        const jobId = pool.newJobId();
        void pool.enqueue({
          jobId,
          pcmBuffer,
          savedWavPath: wavPath,
          segmentIndex: session.segmentIndex,
          startedAt:    session.startedAt,
        }).then((res) => {
          const cleaned = res.ok ? cleanTranscription(res.text ?? '') : '';

          if (res.ok && cleaned.length > 0) {
            // 文字起こし成功 & 発話あり → ここで初めて WAV / TXT を保存する
            try {
              writeWav(wavPath, pcmBuffer);
              writeTxt(txtPath, cleaned);
              health.recordTranscription();
              logLine(`\n${C.green}${C.bold}✅ #${res.segmentIndex} 完了 (${res.durationMs}ms)${C.reset}`);
              logLine(`${C.white}${C.bold}💬 ${cleaned}${C.reset}`);
              logLine(`${C.dim}📁 ${wavPath}${C.reset}`);
              logLine(`${C.dim}📄 ${txtPath}${C.reset}`);
              logger.info(`[TX] #${res.segmentIndex} "${cleaned.slice(0, 80)}" (${res.durationMs}ms)`);
            } catch (err) {
              health.recordError();
              logLine(`\n${C.red}❌ ファイル保存失敗: ${String(err)}${C.reset}`);
              logger.error(`[Save] #${res.segmentIndex} ${String(err)}`);
            }
          } else if (res.ok) {
            // whisper は走ったが、結果が音楽/効果音/沈黙だけ → WAV も TXT も書かない
            health.recordDropped();
            const orig = (res.text ?? '').trim();
            logLine(`\n${C.dim}⏭ #${res.segmentIndex} 発話なし (orig: "${orig.slice(0, 40)}") → 保存スキップ${C.reset}`);
            logger.info(`[TX] #${res.segmentIndex} non-speech 破棄: "${orig.slice(0, 80)}"`);
          } else {
            // 文字起こし自体が失敗
            health.recordError();
            logLine(`\n${C.red}❌ #${res.segmentIndex} 文字起こしエラー: ${res.error}${C.reset}`);
            logger.error(`[TX] #${res.segmentIndex} エラー: ${res.error}`);
          }
        });
      } catch (err) {
        health.recordError();
        logLine(`\n${C.red}❌ ディスパッチャエラー: ${String(err)}${C.reset}`);
        logger.error(`[Dispatch] ${String(err)}`);
      } finally {
        // session 側の参照は早めに切る (ローカル pcmBuffer がクロージャで保持しているので GC される心配はない)
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
  logLine(`${C.yellow}▶ マイク待機中... 話しかけてください${C.reset}`);
  logLine(`${C.dim}  終了: Ctrl+C (1 回目=graceful、もう一度押すと強制終了)${C.reset}`);
  logLine(`${C.dim}${'─'.repeat(60)}${C.reset}`);
}
