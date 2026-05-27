import { EventEmitter } from 'events';
import {
  BoundedBuffer,
  DEFAULT_AUDIO_FORMAT,
  type AudioFormat,
  getBytesPerSecond,
  MIN_RECORD_SECONDS,
  DEFAULT_MAX_SEGMENT_SECONDS,
  DEFAULT_SEGMENT_OVERLAP_SECONDS,
  VOICE_START_FRAMES,
  SILENCE_END_FRAMES,
  pcmToSeconds,
} from './utils';
import { VadProcessor, VadStateMachine, VadMode } from './vad';
import { resolveInputAudioFormat, startAudioCapture, type AudioCaptureProcess } from './platform';
import { logger } from './logger';

export interface RecordingSession {
  pcmBuffer: Buffer;
  audioFormat: AudioFormat;
  startedAt: Date;
  durationSeconds: number;
  /** 通し番号（同一発話内のセグメントを識別） */
  segmentIndex: number;
  /** true ならこのセグメントの後も発話が続く（中間セグメント） */
  continued: boolean;
}

export type RecorderEvent =
  | { type: 'voice_start' }
  | { type: 'voice_segment'; session: RecordingSession }  // 長時間発話の中間切り出し
  | { type: 'voice_end';     session: RecordingSession }  // 沈黙検出による最終セグメント
  | { type: 'too_short';     durationSeconds: number }
  | { type: 'error';         error: Error }
  | { type: 'level';         db: number }
  | { type: 'reconnecting';  attempt: number };

/**
 * マイク入力監視 + VAD 統合レコーダー
 *
 * 修正点:
 * - マイクエラー時の自動再接続（最大 MAX_RECONNECT_ATTEMPTS 回）
 * - preRollBuffer を固定長配列で管理（リーク防止）
 * - activeBuffer は stop() 時に必ず clear() する
 * - isRunning フラグを stop() 前に立てて二重停止を防ぐ
 */
export class VoiceRecorder extends EventEmitter {
  // マイク関連
  private micInstance: AudioCaptureProcess | null = null;
  private micStream:   NodeJS.ReadableStream | null = null;

  // VAD
  private vadProcessor:   VadProcessor;
  private vadStateMachine: VadStateMachine;
  private readonly vadMode: VadMode;

  // 録音バッファ
  private activeBuffer:   BoundedBuffer | null = null;
  private sessionStart:   Date | null = null;
  private segmentIndex = 0;
  private readonly maxSegmentSeconds: number;
  private readonly segmentOverlapSeconds: number;
  private audioFormat: AudioFormat = DEFAULT_AUDIO_FORMAT;
  private captureStartedAt = 0;
  private capturedBytes = 0;
  private sampleRateCalibrated = false;

  // プリロールバッファ（固定サイズ循環）
  private readonly PRE_ROLL_FRAMES = 15; // 150ms
  private preRoll: Buffer[] = [];

  // 状態
  private isRunning = false;

  // 再接続
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY_MS     = 3000;

  private deviceId?: string;

  constructor(
    vadMode: VadMode = VadMode.AGGRESSIVE,
    opts: { maxSegmentSeconds?: number; segmentOverlapSeconds?: number } = {},
  ) {
    super();
    this.vadMode         = vadMode;
    this.vadProcessor    = new VadProcessor(this.vadMode, this.audioFormat);
    this.vadStateMachine = new VadStateMachine(VOICE_START_FRAMES, SILENCE_END_FRAMES);
    this.maxSegmentSeconds     = opts.maxSegmentSeconds     ?? DEFAULT_MAX_SEGMENT_SECONDS;
    this.segmentOverlapSeconds = opts.segmentOverlapSeconds ?? DEFAULT_SEGMENT_OVERLAP_SECONDS;
  }

  start(deviceId?: string): void {
    if (this.isRunning) return;
    this.deviceId   = deviceId;
    this.isRunning  = true;
    this.reconnectAttempts = 0;
    this.startMic();
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false; // 先にフラグを立てて再接続ループを止める

    this.clearReconnectTimer();

    // 録音中セッションを強制終了
    if (this.activeBuffer && this.sessionStart) {
      this.flushSegment(false);
    }

    this.destroyMic();
    this.vadProcessor.destroy();
    this.vadStateMachine.reset();
    this.clearPreRoll();
  }

  // ===== プライベート =====

  private startMic(): void {
    this.audioFormat = resolveInputAudioFormat(this.deviceId);
    this.captureStartedAt = Date.now();
    this.capturedBytes = 0;
    this.sampleRateCalibrated = false;
    this.vadProcessor.destroy();
    this.vadProcessor = new VadProcessor(this.vadMode, this.audioFormat);
    try {
      this.micInstance = startAudioCapture(this.audioFormat, this.deviceId);
      this.micStream   = this.micInstance.process.stdout;
    } catch (err) {
      this.handleMicError(new Error(`マイク初期化失敗: ${String(err)}`));
      return;
    }

    this.micStream!.on('data', (chunk: Buffer) => {
      this.handleChunk(chunk).catch((err: unknown) => {
        logger.error(`[Recorder] チャンク処理エラー: ${String(err)}`);
      });
    });

    this.micStream!.on('error', (err: Error) => {
      this.handleMicError(err);
    });

    this.micInstance.process.on('error', (err: Error) => {
      this.handleMicError(err);
    });
    this.micInstance.process.stderr.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim();
      if (message) logger.warn(`[Recorder] audio backend stderr: ${message}`);
    });
    this.micInstance.process.on('exit', (code, signal) => {
      if (!this.isRunning) return;
      this.handleMicError(new Error(`audio backend exited code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    });

    this.reconnectAttempts = 0;
    logger.info(`[Recorder] マイク開始 sampleRate=${this.audioFormat.sampleRate} channels=${this.audioFormat.channels} bitDepth=${this.audioFormat.bitDepth} command=${this.micInstance.command} args=${this.micInstance.args.join(' ')}`);
  }

  private destroyMic(): void {
    try {
      this.micInstance?.process.kill('SIGTERM');
    } catch { /* ignore */ }
    this.micStream   = null;
    this.micInstance = null;
  }

  private handleMicError(err: Error): void {
    logger.error(`[Recorder] マイクエラー: ${err.message}`);
    this.emit('event', { type: 'error', error: err } satisfies RecorderEvent);

    if (!this.isRunning) return;

    this.destroyMic();
    this.vadProcessor.reset();
    this.vadStateMachine.reset();

    // 録音中セッションを破棄
    this.activeBuffer?.clear();
    this.activeBuffer = null;
    this.sessionStart = null;
    this.clearPreRoll();

    if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      this.emit('event', { type: 'reconnecting', attempt: this.reconnectAttempts } satisfies RecorderEvent);
      logger.warn(`[Recorder] 再接続試行 ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} (${this.RECONNECT_DELAY_MS}ms 後)`);

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.isRunning) this.startMic();
      }, this.RECONNECT_DELAY_MS * this.reconnectAttempts); // 指数バックオフ
    } else {
      logger.error(`[Recorder] 最大再接続回数に達しました。停止します。`);
      this.isRunning = false;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPreRoll(): void {
    // 全参照を null で置き換えて GC を促す
    this.preRoll = [];
  }

  private async handleChunk(chunk: Buffer): Promise<void> {
    if (!this.isRunning) return;
    this.calibrateSampleRate(chunk.length);

    // 音量レベル（ピーク dB）
    const db = this.rmsDb(chunk);
    this.emit('event', { type: 'level', db } satisfies RecorderEvent);

    // プリロールバッファ更新（最大 PRE_ROLL_FRAMES 件）
    this.preRoll.push(chunk);
    if (this.preRoll.length > this.PRE_ROLL_FRAMES) {
      this.preRoll.shift(); // 古い参照を削除
    }

    // VAD 処理
    const events = await this.vadProcessor.processChunk(chunk);

    for (const evt of events) {
      const state = this.vadStateMachine.update(evt.result);

      if (state.started) {
        this.onVoiceStart();
      } else if (state.stopped) {
        this.onVoiceEnd();
        return;
      }
    }

    // 録音中ならバッファに追加 → セグメント上限到達なら切り出す
    if (this.activeBuffer) {
      this.activeBuffer.push(chunk);
      if (this.activeBuffer.byteLength >= Math.floor(this.maxSegmentSeconds * getBytesPerSecond(this.audioFormat))) {
        this.flushSegment(true);
      }
    }
  }

  private onVoiceStart(): void {
    this.sessionStart = new Date();
    this.activeBuffer = new BoundedBuffer(this.audioFormat);
    this.segmentIndex = 0;

    // プリロール（音声開始前のデータを先頭に追加）
    for (const b of this.preRoll) {
      this.activeBuffer.push(b);
    }
    this.clearPreRoll();

    this.emit('event', { type: 'voice_start' } satisfies RecorderEvent);
  }

  private onVoiceEnd(): void {
    this.flushSegment(false);
  }

  /**
   * 現在の activeBuffer をセグメントとして emit する。
   * @param continued true なら中間セグメント (録音継続)、false なら最終セグメント (voice_end)
   */
  private flushSegment(continued: boolean): void {
    if (!this.activeBuffer || !this.sessionStart) return;

    const pcmBuffer       = this.activeBuffer.concat();
    const durationSeconds = pcmToSeconds(pcmBuffer.length, this.audioFormat);
    const startedAt       = this.sessionStart;
    const idx             = this.segmentIndex++;

    // バッファクリア (continued の場合はオーバーラップを次バッファに繰り越す)
    let overlapTail: Buffer | null = null;
    const overlapBytes = Math.max(0, Math.floor(this.segmentOverlapSeconds * getBytesPerSecond(this.audioFormat)));
    if (continued && overlapBytes > 0) {
      overlapTail = this.activeBuffer.splitTail(overlapBytes);
    }
    this.activeBuffer.clear();

    if (continued) {
      // 次セグメント用バッファを準備
      this.activeBuffer = new BoundedBuffer(this.audioFormat);
      if (overlapTail && overlapTail.length > 0) {
        this.activeBuffer.push(overlapTail);
      }
      this.sessionStart = new Date();
    } else {
      this.activeBuffer = null;
      this.sessionStart = null;
    }

    if (durationSeconds < MIN_RECORD_SECONDS && !continued && idx === 0) {
      this.emit('event', { type: 'too_short', durationSeconds } satisfies RecorderEvent);
      return;
    }

    const session: RecordingSession = {
      pcmBuffer,
      audioFormat: this.audioFormat,
      startedAt,
      durationSeconds,
      segmentIndex: idx,
      continued,
    };
    this.emit('event', {
      type: continued ? 'voice_segment' : 'voice_end',
      session,
    } satisfies RecorderEvent);
  }

  private rmsDb(chunk: Buffer): number {
    let sum = 0;
    const n = chunk.length / 2;
    for (let i = 0; i < chunk.length; i += 2) {
      const s = chunk.readInt16LE(i) / 32768;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / n);
    return rms > 0 ? 20 * Math.log10(rms) : -100;
  }

  private calibrateSampleRate(chunkBytes: number): void {
    if (this.sampleRateCalibrated) return;

    this.capturedBytes += chunkBytes;
    const elapsedSeconds = (Date.now() - this.captureStartedAt) / 1000;
    if (elapsedSeconds < 2.0) return;

    this.sampleRateCalibrated = true;
    const bytesPerSampleFrame = this.audioFormat.channels * (this.audioFormat.bitDepth / 8);
    const measuredRate = Math.round(this.capturedBytes / elapsedSeconds / bytesPerSampleFrame);
    const normalizedRate = normalizeSampleRate(measuredRate);
    const currentRate = this.audioFormat.sampleRate;

    logger.info(`[Recorder] sampleRate calibration measured=${measuredRate} normalized=${normalizedRate} configured=${currentRate} elapsed=${elapsedSeconds.toFixed(2)}s bytes=${this.capturedBytes}`);

    if (!normalizedRate || Math.abs(normalizedRate - currentRate) / currentRate < 0.10) return;

    this.audioFormat = { ...this.audioFormat, sampleRate: normalizedRate };
    this.vadProcessor.destroy();
    this.vadProcessor = new VadProcessor(this.vadMode, this.audioFormat);
    if (this.activeBuffer) {
      const old = this.activeBuffer.concat();
      this.activeBuffer.clear();
      this.activeBuffer = new BoundedBuffer(this.audioFormat);
      this.activeBuffer.push(old);
    }

    logger.warn(`[Recorder] sampleRate mismatch corrected configured=${currentRate} actual=${normalizedRate}`);
  }
}

function normalizeSampleRate(rate: number): number | undefined {
  const commonRates = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000];
  let best = commonRates[0];
  let bestDiff = Math.abs(rate - best);
  for (const candidate of commonRates.slice(1)) {
    const diff = Math.abs(rate - candidate);
    if (diff < bestDiff) {
      best = candidate;
      bestDiff = diff;
    }
  }
  return bestDiff / best <= 0.12 ? best : undefined;
}
