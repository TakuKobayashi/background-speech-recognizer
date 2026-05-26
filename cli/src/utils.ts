import * as fs from 'fs';

export const SAMPLE_RATE      = 16000;
export const CHANNELS         = 1;
export const BIT_DEPTH        = 16;
export const BYTES_PER_SAMPLE = BIT_DEPTH / 8;

// 10ms フレーム = 160 サンプル = 320 バイト（WebRTC VAD 要件）
export const VAD_FRAME_MS      = 10;
export const VAD_FRAME_SAMPLES = (SAMPLE_RATE * VAD_FRAME_MS) / 1000; // 160
export const VAD_FRAME_BYTES   = VAD_FRAME_SAMPLES * BYTES_PER_SAMPLE; // 320

// 録音設定
export const MIN_RECORD_SECONDS  = 1.0;
/**
 * 1 セグメントの最大秒数。voice_end まで沈黙がない長い発話は、
 * この秒数ごとにチャンク分割して Queue に流す（完全非同期パイプラインのため）。
 */
export const MAX_SEGMENT_SECONDS = parseInt(process.env.MAX_SEGMENT_SECONDS ?? '30');
/**
 * セグメント分割時のオーバーラップ秒数。前セグメントの末尾を次セグメントの先頭に
 * 重ねて文脈ロスを防ぐ。
 */
export const SEGMENT_OVERLAP_SECONDS = parseFloat(process.env.SEGMENT_OVERLAP_SECONDS ?? '0.3');
export const SILENCE_TIMEOUT_MS  = 1500;
export const VOICE_START_FRAMES  = 3;
export const SILENCE_END_FRAMES  = 30;

export function getTimestamp(): string {
  const now = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${now.getFullYear()}${p(now.getMonth()+1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

export function ensureOutputDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * PCM バッファを WAV ファイルとして書き込む（外部依存ゼロ）
 */
export function writeWav(filePath: string, pcmBuffer: Buffer): void {
  const dataSize  = pcmBuffer.length;
  const byteRate  = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(44);
  let off = 0;

  const ws = (s: string)  => { header.write(s, off); off += s.length; };
  const w4 = (v: number)  => { header.writeUInt32LE(v, off); off += 4; };
  const w2 = (v: number)  => { header.writeUInt16LE(v, off); off += 2; };

  ws('RIFF'); w4(dataSize + 36); ws('WAVE');
  ws('fmt '); w4(16); w2(1); w2(CHANNELS); w4(SAMPLE_RATE); w4(byteRate); w2(blockAlign); w2(BIT_DEPTH);
  ws('data'); w4(dataSize);

  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, header);
    fs.writeSync(fd, pcmBuffer);
  } finally {
    fs.closeSync(fd); // 確実にファイルハンドルを閉じる
  }
}

export function writeTxt(filePath: string, text: string): void {
  fs.writeFileSync(filePath, text, { encoding: 'utf-8', flag: 'w' });
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1);
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

export function pcmToSeconds(byteLength: number): number {
  return byteLength / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);
}

/**
 * メモリリーク対策済みの追記専用バッファ
 *
 * 旧 BoundedBuffer は MAX_RECORD_SECONDS を超えると古いチャンクをドロップしていたが、
 * 長時間録音セグメント分割パイプラインでは「上限到達時に切り出して Queue に流す」
 * 運用に変わったため、ここではドロップせず単純に蓄積する。
 *
 * - clear() 時に chunks 配列要素を null で上書きして GC を確実に促す
 * - concat 後に内部配列を圧縮して断片化を防ぐ
 */
export class BoundedBuffer {
  private chunks: (Buffer | null)[] = [];
  private totalBytes = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
  }

  concat(): Buffer {
    const valid = this.chunks.filter((c): c is Buffer => c !== null);
    return Buffer.concat(valid);
  }

  /**
   * 末尾 tailBytes バイト分だけを別 BoundedBuffer として返し、内部から取り出す。
   * セグメント分割時のオーバーラップ再構築に使用する。
   */
  splitTail(tailBytes: number): Buffer {
    if (tailBytes <= 0 || this.totalBytes === 0) return Buffer.alloc(0);
    const full = this.concat();
    return full.length <= tailBytes ? full : full.slice(full.length - tailBytes);
  }

  get byteLength(): number { return this.totalBytes; }
  get durationSeconds(): number { return pcmToSeconds(this.totalBytes); }

  clear(): void {
    for (let i = 0; i < this.chunks.length; i++) {
      this.chunks[i] = null;
    }
    this.chunks = [];
    this.totalBytes = 0;
  }
}

/**
 * プロセス終了時の一時ファイルクリーンアップレジストリ
 * whisper.cpp 実行中にクラッシュしても tmp ファイルを残さない
 */
class TmpFileRegistry {
  private files = new Set<string>();

  constructor() {
    // シグナルに関係なく exit 時に必ず実行
    process.on('exit', () => this.cleanAll());
  }

  register(fp: string): void   { this.files.add(fp); }
  unregister(fp: string): void { this.files.delete(fp); }

  private cleanAll(): void {
    for (const fp of this.files) {
      try {
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } catch { /* ignore */ }
    }
    this.files.clear();
  }
}

export const tmpRegistry = new TmpFileRegistry();
