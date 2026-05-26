import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LoggerConfig {
  logDir:        string;
  maxFileMb:     number;
  maxLogFiles:   number;
  enableConsole: boolean;
  minLevel:      LogLevel;
}

const DEFAULT_CONFIG: LoggerConfig = {
  logDir:        './logs',
  maxFileMb:     10,
  maxLogFiles:   7,
  enableConsole: true,
  minLevel:      'INFO',
};

const LOG_PREFIX = 'whisper-cli';
const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const ANSI: Record<LogLevel, string> = {
  DEBUG: '\x1b[37m', // white
  INFO:  '\x1b[36m', // cyan
  WARN:  '\x1b[33m', // yellow
  ERROR: '\x1b[31m', // red
};
const ANSI_RESET = '\x1b[0m';

class RotatingLogger {
  private config: LoggerConfig = { ...DEFAULT_CONFIG };
  private stream: fs.WriteStream | null = null;
  private currentDate = '';
  private currentSizeBytes = 0;
  private rotateIndex = 0;
  private exitHandlerRegistered = false;

  /**
   * 設定を上書きする。既に書き込み先がオープン済みなら一度閉じてから次回書き込み時に
   * 新しい設定で開き直す (logDir 等が変わってもファイル / ディレクトリは作り直されない)。
   * runStart の冒頭で 1 度だけ呼ぶ想定。
   */
  configure(opts: Partial<LoggerConfig>): void {
    if (this.stream) this.closeStream();
    this.config = { ...this.config, ...opts };
  }

  private ensureOpen(): void {
    if (this.stream) return;
    this.ensureDir();
    this.openStream();
    if (!this.exitHandlerRegistered) {
      process.on('exit', () => this.close());
      this.exitHandlerRegistered = true;
    }
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.config.logDir)) {
      fs.mkdirSync(this.config.logDir, { recursive: true });
    }
  }

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  private logFilePath(date: string, index: number): string {
    const suffix = index > 0 ? `.${index}` : '';
    return path.join(this.config.logDir, `${LOG_PREFIX}-${date}${suffix}.log`);
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
      if (fs.statSync(fp).size < this.config.maxFileMb * 1024 * 1024) return i;
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
      const files = fs.readdirSync(this.config.logDir)
        .filter(f => f.startsWith(LOG_PREFIX) && f.endsWith('.log'))
        .map(f => ({
          fp: path.join(this.config.logDir, f),
          mt: fs.statSync(path.join(this.config.logDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mt - a.mt);
      files.slice(this.config.maxLogFiles).forEach(({ fp }) => {
        try { fs.unlinkSync(fp); } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
  }

  write(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.config.minLevel]) return;
    this.ensureOpen();

    const ts  = new Date().toISOString();
    const line = `[${ts}] [${level.padEnd(5)}] ${message}${os.EOL}`;
    const bytes = Buffer.byteLength(line, 'utf8');

    // ローテーション判定
    const today = this.todayStr();
    if (today !== this.currentDate || this.currentSizeBytes + bytes > this.config.maxFileMb * 1024 * 1024) {
      this.rotate();
    }

    // ファイル書き込み
    if (this.stream && !this.stream.destroyed) {
      this.stream.write(line);
      this.currentSizeBytes += bytes;
    }

    // コンソール出力
    if (this.config.enableConsole) {
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
