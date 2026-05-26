import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_DIR         = process.env.LOG_DIR ?? './logs';
const MAX_FILE_MB     = parseInt(process.env.LOG_MAX_MB ?? '10');
const MAX_LOG_FILES   = parseInt(process.env.LOG_MAX_FILES ?? '7');
const LOG_PREFIX      = 'whisper-cli';
const ENABLE_CONSOLE  = process.env.LOG_CONSOLE !== 'false';
const MIN_LEVEL       = (process.env.LOG_LEVEL ?? 'INFO') as LogLevel;

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const ANSI: Record<LogLevel, string> = {
  DEBUG: '\x1b[37m',  // white
  INFO:  '\x1b[36m',  // cyan
  WARN:  '\x1b[33m',  // yellow
  ERROR: '\x1b[31m',  // red
};
const ANSI_RESET = '\x1b[0m';

class RotatingLogger {
  private stream: fs.WriteStream | null = null;
  private currentDate = '';
  private currentSizeBytes = 0;
  private rotateIndex = 0;

  constructor() {
    this.ensureDir();
    this.openStream();
    // プロセス終了時にストリームを閉じる
    process.on('exit', () => this.close());
  }

  private ensureDir(): void {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  }

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  private logFilePath(date: string, index: number): string {
    const suffix = index > 0 ? `.${index}` : '';
    return path.join(LOG_DIR, `${LOG_PREFIX}-${date}${suffix}.log`);
  }

  private openStream(): void {
    this.closeStream();
    this.currentDate = this.todayStr();
    this.rotateIndex = this.findNextIndex(this.currentDate);
    const fp = this.logFilePath(this.currentDate, this.rotateIndex);
    this.currentSizeBytes = fs.existsSync(fp) ? fs.statSync(fp).size : 0;
    this.stream = fs.createWriteStream(fp, { flags: 'a', encoding: 'utf8' });
    this.stream.on('error', (err) => {
      process.stderr.write(`[Logger] stream error: ${err.message}\n`);
    });
    this.pruneOldFiles();
  }

  private findNextIndex(date: string): number {
    for (let i = 0; i < 100; i++) {
      const fp = this.logFilePath(date, i);
      if (!fs.existsSync(fp)) return i;
      if (fs.statSync(fp).size < MAX_FILE_MB * 1024 * 1024) return i;
    }
    return 0;
  }

  private closeStream(): void {
    if (this.stream && !this.stream.destroyed) {
      this.stream.end();
      this.stream = null;
    }
  }

  private rotate(): void {
    const today = this.todayStr();
    if (today !== this.currentDate) {
      this.rotateIndex = 0;
    } else {
      this.rotateIndex++;
    }
    this.openStream();
  }

  private pruneOldFiles(): void {
    try {
      const files = fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith(LOG_PREFIX) && f.endsWith('.log'))
        .map(f => ({ fp: path.join(LOG_DIR, f), mt: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mt - a.mt);
      files.slice(MAX_LOG_FILES).forEach(({ fp }) => {
        try { fs.unlinkSync(fp); } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
  }

  write(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;

    const ts  = new Date().toISOString();
    const line = `[${ts}] [${level.padEnd(5)}] ${message}${os.EOL}`;
    const bytes = Buffer.byteLength(line, 'utf8');

    // ローテーション判定
    const today = this.todayStr();
    if (today !== this.currentDate || this.currentSizeBytes + bytes > MAX_FILE_MB * 1024 * 1024) {
      this.rotate();
    }

    // ファイル書き込み
    if (this.stream && !this.stream.destroyed) {
      this.stream.write(line);
      this.currentSizeBytes += bytes;
    }

    // コンソール出力
    if (ENABLE_CONSOLE) {
      const out = `${ANSI[level]}[${ts}] [${level.padEnd(5)}] ${message}${ANSI_RESET}`;
      if (level === 'ERROR' || level === 'WARN') {
        process.stderr.write(out + os.EOL);
      } else {
        process.stdout.write(out + os.EOL);
      }
    }
  }

  debug(msg: string): void { this.write('DEBUG', msg); }
  info(msg: string):  void { this.write('INFO',  msg); }
  warn(msg: string):  void { this.write('WARN',  msg); }
  error(msg: string): void { this.write('ERROR', msg); }

  close(): void {
    this.closeStream();
  }
}

export const logger = new RotatingLogger();
