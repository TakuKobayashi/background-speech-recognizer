import * as os from 'os';
import { EventEmitter } from 'events';
import { logger } from './logger';

export interface HealthStatus {
  uptimeSeconds: number;
  heapUsedMb: number;
  rssUsedMb: number;
  cpuLoad1m: number;
  transcriptions: number;
  errors: number;
  droppedSessions: number;
  micRestarts: number;
  lastActivityAt: Date | null;
}

/**
 * 24/7 運用向けヘルスモニター
 * - メモリ使用量・CPU 負荷の定期ログ
 * - 警告しきい値超過時に GC ヒント
 * - 外部監視ツール連携用 StatusEmitter
 */
export class HealthMonitor extends EventEmitter {
  private startTime = Date.now();
  private transcriptions = 0;
  private errors = 0;
  private droppedSessions = 0;
  private micRestarts = 0;
  private lastActivityAt: Date | null = null;
  private timer: NodeJS.Timeout | null = null;

  private readonly HEAP_WARN_MB  = 300;
  private readonly HEAP_FATAL_MB = 500;
  private readonly CHECK_INTERVAL_MS = 60_000; // 1 分

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.CHECK_INTERVAL_MS);
    this.timer.unref(); // Node.js 終了をブロックしない
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  recordTranscription(): void { this.transcriptions++; this.lastActivityAt = new Date(); }
  recordError():         void { this.errors++; }
  recordDropped():       void { this.droppedSessions++; }
  recordMicRestart():    void { this.micRestarts++; }

  getStatus(): HealthStatus {
    const mem = process.memoryUsage();
    return {
      uptimeSeconds:   Math.floor((Date.now() - this.startTime) / 1000),
      heapUsedMb:      Math.round(mem.heapUsed  / 1024 / 1024),
      rssUsedMb:       Math.round(mem.rss       / 1024 / 1024),
      cpuLoad1m:       os.loadavg()[0],
      transcriptions:  this.transcriptions,
      errors:          this.errors,
      droppedSessions: this.droppedSessions,
      micRestarts:     this.micRestarts,
      lastActivityAt:  this.lastActivityAt,
    };
  }

  private check(): void {
    const s = this.getStatus();
    logger.info(
      `[Health] uptime=${this.fmt(s.uptimeSeconds)} ` +
      `heap=${s.heapUsedMb}MB rss=${s.rssUsedMb}MB ` +
      `cpu=${s.cpuLoad1m.toFixed(2)} ` +
      `tx=${s.transcriptions} err=${s.errors} ` +
      `drop=${s.droppedSessions} micRestart=${s.micRestarts}`
    );

    if (s.heapUsedMb > this.HEAP_FATAL_MB) {
      logger.error(`[Health] HEAP CRITICAL ${s.heapUsedMb}MB — プロセス再起動を推奨`);
      this.emit('critical', s);
    } else if (s.heapUsedMb > this.HEAP_WARN_MB) {
      logger.warn(`[Health] heap 警告 ${s.heapUsedMb}MB`);
      // GC ヒント（--expose-gc で有効）
      (global as { gc?: () => void }).gc?.();
      this.emit('warning', s);
    }

    this.emit('status', s);
  }

  private fmt(s: number): string {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}h${String(m).padStart(2,'0')}m${String(sec).padStart(2,'0')}s`;
  }
}
