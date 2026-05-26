import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import * as path from 'path';
import { logger } from '../logger';

export interface TranscriberPoolOptions {
  whisperBin: string;
  modelPath:  string;
  language?:  string;
  threads?:   number;
  timeoutMs?: number;
  /** 同時に走らせる worker_thread 数 (デフォルト 1) */
  concurrency?: number;
}

export interface TranscribeJob {
  jobId: string;
  pcmBuffer: Buffer;
  savedWavPath?: string;
  segmentIndex: number;
  startedAt: Date;
}

export interface TranscribeJobResult {
  jobId: string;
  ok: boolean;
  text?: string;
  durationMs?: number;
  error?: string;
  savedWavPath?: string;
  segmentIndex: number;
  startedAt: Date;
}

interface InternalJob extends TranscribeJob {
  resolve: (r: TranscribeJobResult) => void;
}

/**
 * worker_threads ベースの Transcriber ワーカープール
 *
 * メインスレッドの録音/VAD ループは PCM Buffer を postMessage で渡すだけで、
 * whisper.cpp の起動・I/O・結果パースは全部別スレッドで動く。Transferable に
 * 載せて転送するためコピーコストもゼロ。
 */
export class TranscriberPool extends EventEmitter {
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private busyMap = new Map<Worker, InternalJob>();
  private queue: InternalJob[] = [];
  private nextJobId = 0;
  private shuttingDown = false;

  constructor(private readonly options: TranscriberPoolOptions) {
    super();
    const concurrency = Math.max(1, options.concurrency ?? 1);
    for (let i = 0; i < concurrency; i++) {
      this.spawnWorker();
    }
    logger.info(`[Pool] worker_thread x${concurrency} 起動`);
  }

  /**
   * ジョブを投入する。Promise で結果を返す。
   * 失敗しても reject せず、result.ok=false で返す（パイプライン継続のため）。
   */
  enqueue(job: TranscribeJob): Promise<TranscribeJobResult> {
    return new Promise((resolve) => {
      const internal: InternalJob = { ...job, resolve };
      this.queue.push(internal);
      this.emit('enqueued', { jobId: job.jobId, queueDepth: this.queue.length });
      this.dispatch();
    });
  }

  get queueDepth(): number { return this.queue.length; }
  get busyCount():  number { return this.busyMap.size; }

  /** ワーカー全停止 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    // 待機中ジョブは未処理として resolve (失敗扱い)
    for (const j of this.queue) {
      j.resolve({
        jobId: j.jobId, ok: false, error: 'pool shutdown',
        segmentIndex: j.segmentIndex, startedAt: j.startedAt,
      });
    }
    this.queue.length = 0;

    await Promise.all(this.workers.map(async (w) => {
      try {
        w.postMessage({ type: 'shutdown' });
      } catch { /* ignore */ }
      try { await w.terminate(); } catch { /* ignore */ }
    }));
    this.workers = [];
    this.idleWorkers = [];
    this.busyMap.clear();
  }

  // ===== 内部 =====

  private spawnWorker(): void {
    const workerPath = this.resolveWorkerPath();
    const worker = new Worker(workerPath, {
      workerData: {
        whisperBin: this.options.whisperBin,
        modelPath:  this.options.modelPath,
        language:   this.options.language,
        threads:    this.options.threads,
        timeoutMs:  this.options.timeoutMs,
      },
      // tsx 経由で .ts を直接ロードできるよう、CommonJS モード向け register を有効化
      execArgv: workerPath.endsWith('.ts') ? ['--require', 'tsx/cjs'] : [],
    });

    worker.on('message', (msg: { type: string; jobId: string; ok: boolean; text?: string; durationMs?: number; error?: string; savedWavPath?: string; segmentIndex: number; startedAtIso: string }) => {
      if (msg.type !== 'result') return;
      const job = this.busyMap.get(worker);
      if (!job || job.jobId !== msg.jobId) {
        logger.warn(`[Pool] 未知の jobId 受信: ${msg.jobId}`);
        return;
      }
      this.busyMap.delete(worker);
      this.idleWorkers.push(worker);

      const result: TranscribeJobResult = {
        jobId: msg.jobId,
        ok: msg.ok,
        ...(msg.text !== undefined ? { text: msg.text } : {}),
        ...(msg.durationMs !== undefined ? { durationMs: msg.durationMs } : {}),
        ...(msg.error !== undefined ? { error: msg.error } : {}),
        ...(msg.savedWavPath !== undefined ? { savedWavPath: msg.savedWavPath } : {}),
        segmentIndex: msg.segmentIndex,
        startedAt: new Date(msg.startedAtIso),
      };
      job.resolve(result);
      this.emit('completed', result);
      this.dispatch();
    });

    worker.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Pool] worker error: ${msg}`);
      const job = this.busyMap.get(worker);
      if (job) {
        this.busyMap.delete(worker);
        job.resolve({
          jobId: job.jobId, ok: false, error: msg,
          segmentIndex: job.segmentIndex, startedAt: job.startedAt,
        });
      }
      this.replaceWorker(worker);
    });

    worker.on('exit', (code) => {
      if (this.shuttingDown) return;
      logger.warn(`[Pool] worker exit code=${code} — 再起動`);
      this.replaceWorker(worker);
    });

    this.workers.push(worker);
    this.idleWorkers.push(worker);
  }

  private replaceWorker(dead: Worker): void {
    this.workers = this.workers.filter(w => w !== dead);
    this.idleWorkers = this.idleWorkers.filter(w => w !== dead);
    this.busyMap.delete(dead);
    if (!this.shuttingDown) {
      this.spawnWorker();
      this.dispatch();
    }
  }

  private dispatch(): void {
    while (this.idleWorkers.length > 0 && this.queue.length > 0) {
      const worker = this.idleWorkers.shift()!;
      const job    = this.queue.shift()!;
      this.busyMap.set(worker, job);

      // Buffer.buffer は ArrayBuffer | SharedArrayBuffer を返すので、
      // 通常 ArrayBuffer を新たに切り出してから Transferable として渡す
      const copy = new ArrayBuffer(job.pcmBuffer.byteLength);
      new Uint8Array(copy).set(job.pcmBuffer);
      worker.postMessage({
        type: 'job',
        jobId: job.jobId,
        pcmBuffer: copy,
        savedWavPath: job.savedWavPath,
        segmentIndex: job.segmentIndex,
        startedAtIso: job.startedAt.toISOString(),
      }, [copy]);
    }
  }

  private resolveWorkerPath(): string {
    // dist/worker/transcriber-worker.js (本番) or src/worker/transcriber-worker.ts (tsx dev)
    const isTs = __filename.endsWith('.ts');
    const fileName = isTs ? 'transcriber-worker.ts' : 'transcriber-worker.js';
    return path.join(__dirname, fileName);
  }

  /** ユニークな jobId を発行 */
  newJobId(): string {
    return `j${Date.now()}_${this.nextJobId++}`;
  }
}
