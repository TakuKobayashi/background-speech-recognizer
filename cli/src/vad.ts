import { EventEmitter } from 'events';
import { VAD_FRAME_BYTES, SAMPLE_RATE } from './utils';
import { logger } from './logger';

export enum VadMode {
  NORMAL        = 0,
  LOW_BITRATE   = 1,
  AGGRESSIVE    = 2,
  VERY_AGGRESSIVE = 3,
}

export enum VadResult {
  SILENCE = 'SILENCE',
  VOICE   = 'VOICE',
  ERROR   = 'ERROR',
}

export type VadEvent = {
  result: VadResult;
  frameIndex: number;
};

// ===================================================================
// node-vad のロード（失敗時はエネルギーベース VAD にフォールバック）
// ===================================================================
let nodeVadClass: (new (mode: number) => { processAudio(frame: Buffer, rate: number): Promise<number> }) | null = null;
let NODE_VAD_VOICE_EVENT = 3; // node-vad v1: ERROR=0, SILENCE=1, NO_VOICE=2, VOICE=3

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require('node-vad');
  nodeVadClass = pkg;
  // パッケージが Event 定数を公開していれば使う
  if (pkg.Event?.VOICE !== undefined) {
    NODE_VAD_VOICE_EVENT = pkg.Event.VOICE;
  }
  logger.info('[VAD] node-vad ロード成功');
} catch (err) {
  logger.warn(`[VAD] node-vad ロード失敗 → エネルギーベース VAD で代替: ${String(err)}`);
}

// ===================================================================
// エネルギーベース VAD（node-vad フォールバック・Pure TypeScript）
// ===================================================================
class EnergyVad {
  private noiseFloor = -55;  // dBFS
  private readonly ATTACK_ALPHA  = 0.05;
  private readonly DECAY_ALPHA   = 0.002;

  async processAudio(frame: Buffer, _sampleRate: number): Promise<number> {
    const db = this.rmsDb(frame);
    const dynamicThreshold = this.noiseFloor + 14;

    if (db < dynamicThreshold) {
      // ノイズフロアを下方向に適応更新
      this.noiseFloor += (db - this.noiseFloor) * this.DECAY_ALPHA;
      return 1; // SILENCE
    } else {
      // 音声フロアを上方向に適応更新
      this.noiseFloor += (db - this.noiseFloor) * this.ATTACK_ALPHA;
      return 3; // VOICE (node-vad 互換値)
    }
  }

  private rmsDb(frame: Buffer): number {
    let sum = 0;
    const n = frame.length / 2;
    for (let i = 0; i < frame.length; i += 2) {
      const s = frame.readInt16LE(i) / 32768;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / n);
    return rms > 0 ? 20 * Math.log10(rms) : -100;
  }
}

// ===================================================================
// VadProcessor - 共通インタフェース
// ===================================================================
export class VadProcessor extends EventEmitter {
  private readonly vad: { processAudio(frame: Buffer, rate: number): Promise<number> };
  private frameIndex  = 0;
  // 修正: residualBuffer は必ず VAD_FRAME_BYTES 未満に保つ
  private residual = Buffer.alloc(0);

  constructor(mode: VadMode = VadMode.AGGRESSIVE) {
    super();
    if (nodeVadClass) {
      try {
        this.vad = new nodeVadClass(mode);
      } catch {
        logger.warn('[VAD] node-vad インスタンス生成失敗 → フォールバック');
        this.vad = new EnergyVad();
      }
    } else {
      this.vad = new EnergyVad();
    }
  }

  /**
   * 任意サイズの PCM チャンクを受け取り 10ms フレーム単位で処理する
   * 残余は次回に持ち越す（最大 VAD_FRAME_BYTES - 1 バイト）
   */
  async processChunk(chunk: Buffer): Promise<VadEvent[]> {
    // 残余バッファが VAD_FRAME_BYTES を超えていたら捨てる（異常系ガード）
    if (this.residual.length >= VAD_FRAME_BYTES) {
      logger.warn('[VAD] residualBuffer overflow — リセット');
      this.residual = Buffer.alloc(0);
    }

    const buf = Buffer.concat([this.residual, chunk]);
    const events: VadEvent[] = [];
    let offset = 0;

    while (offset + VAD_FRAME_BYTES <= buf.length) {
      const frame = buf.slice(offset, offset + VAD_FRAME_BYTES);
      offset += VAD_FRAME_BYTES;

      try {
        const raw = await this.vad.processAudio(frame, SAMPLE_RATE);
        const result: VadResult = raw === NODE_VAD_VOICE_EVENT ? VadResult.VOICE : VadResult.SILENCE;
        const evt: VadEvent = { result, frameIndex: this.frameIndex++ };
        events.push(evt);
        this.emit('frame', evt);
      } catch (err) {
        logger.warn(`[VAD] フレーム処理エラー: ${String(err)}`);
        events.push({ result: VadResult.ERROR, frameIndex: this.frameIndex++ });
      }
    }

    // 残余を保存（VAD_FRAME_BYTES 未満を保証）
    this.residual = buf.slice(offset);
    return events;
  }

  reset(): void {
    this.residual = Buffer.alloc(0);
    this.frameIndex = 0;
  }

  destroy(): void {
    this.residual = Buffer.alloc(0);
    this.removeAllListeners();
  }
}

// ===================================================================
// VadStateMachine - ヒステリシス付きステートマシン
// ===================================================================
export class VadStateMachine {
  private consecutiveVoice   = 0;
  private consecutiveSilence = 0;
  private _active = false;

  constructor(
    private readonly voiceStartFrames: number,
    private readonly silenceEndFrames: number,
  ) {}

  update(result: VadResult): { started: boolean; stopped: boolean; active: boolean } {
    if (result === VadResult.VOICE) {
      this.consecutiveVoice++;
      this.consecutiveSilence = 0;
    } else {
      this.consecutiveSilence++;
      this.consecutiveVoice = 0;
    }

    let started = false;
    let stopped = false;

    if (!this._active && this.consecutiveVoice >= this.voiceStartFrames) {
      this._active = true;
      started = true;
    } else if (this._active && this.consecutiveSilence >= this.silenceEndFrames) {
      this._active = false;
      stopped = true;
      this.consecutiveVoice = 0;
    }

    return { started, stopped, active: this._active };
  }

  get isVoiceActive(): boolean { return this._active; }

  reset(): void {
    this.consecutiveVoice   = 0;
    this.consecutiveSilence = 0;
    this._active = false;
  }
}
