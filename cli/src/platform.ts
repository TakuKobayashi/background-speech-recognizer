import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MACOS   = process.platform === 'darwin';
export const IS_LINUX   = process.platform === 'linux';

/**
 * Windows では setRawMode が非 TTY 環境でクラッシュするため安全ラッパーを使用
 */
export function trySetRawMode(stream: typeof process.stdin): boolean {
  if (!stream.isTTY) return false;
  if (typeof stream.setRawMode !== 'function') return false;
  try {
    stream.setRawMode(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * プラットフォーム別デフォルト whisper.cpp バイナリパス
 */
export function getDefaultWhisperBin(): string {
  if (IS_WINDOWS) {
    // Windows: CMake Release ビルドのデフォルトパス
    return path.join('.', 'whisper.cpp', 'build', 'bin', 'Release', 'whisper-cli.exe');
  }
  return path.join('.', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
}

/**
 * プラットフォーム互換のプロセス終了
 * Windows では SIGKILL が使用できないため代替手段を使う
 */
export function killProcess(pid: number): void {
  try {
    if (IS_WINDOWS) {
      execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // プロセスが既に終了している場合は無視
  }
}

/**
 * mic パッケージのデバイス設定（プラットフォーム別）
 */
export function getMicConfig(sampleRate: number, deviceId?: string): Record<string, string> {
  const base: Record<string, string> = {
    rate: String(sampleRate),
    channels: '1',
    encoding: 'signed-integer',
    bitwidth: '16',
    endian: 'little',
    fileType: 'raw',
  };
  if (deviceId) {
    base.device = deviceId;
  }
  return base;
}

/**
 * sox / arecord のインストール確認
 */
export function checkAudioDependency(): { ok: boolean; message: string } {
  const cmd = IS_LINUX ? 'arecord' : 'sox';
  try {
    execSync(`${cmd} --version 2>&1`, { stdio: 'ignore' });
    return { ok: true, message: `${cmd} が見つかりました` };
  } catch {
    if (IS_LINUX) {
      return { ok: false, message: 'arecord が見つかりません。sudo apt install alsa-utils でインストールしてください。' };
    } else if (IS_WINDOWS) {
      return { ok: false, message: 'sox が見つかりません。npm run setup-whisper で自動 DL するか、手動でインストールしてください: https://sourceforge.net/projects/sox/' };
    } else {
      return { ok: false, message: 'sox が見つかりません。npm run setup-whisper で自動 install するか、brew install sox を実行してください。' };
    }
  }
}

/**
 * `vendor/` 配下に setup-whisper が自動 DL した実行ファイル (sox, cmake など) が
 * あれば PATH の先頭に追加する。start / doctor の冒頭で呼び出して、その後の
 * mic ライブラリや checkAudioDependency が vendor の sox を見つけられるようにする。
 */
export function prependVendorBinsToPath(): void {
  const vendorDir = path.resolve(process.cwd(), 'vendor');
  if (!fs.existsSync(vendorDir)) return;

  const sep      = IS_WINDOWS ? ';' : ':';
  const soxName  = IS_WINDOWS ? 'sox.exe' : 'sox';
  const additions: string[] = [];

  // vendor/sox/ 直下、または vendor/sox/<release-dir>/ 配下を探す
  const soxRoot = path.join(vendorDir, 'sox');
  if (fs.existsSync(soxRoot)) {
    if (fs.existsSync(path.join(soxRoot, soxName))) {
      additions.push(soxRoot);
    } else {
      for (const entry of fs.readdirSync(soxRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sub = path.join(soxRoot, entry.name);
        if (fs.existsSync(path.join(sub, soxName))) additions.push(sub);
      }
    }
  }

  if (additions.length === 0) return;
  process.env.PATH = additions.join(sep) + sep + (process.env.PATH ?? '');
}

/**
 * 一時ファイルパスを生成（プラットフォーム対応）
 */
export function makeTmpPath(prefix: string, ext: string): string {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), `${prefix}_${id}.${ext}`);
}

/**
 * ファイルを安全に削除（存在しなくてもエラーにしない）
 */
export function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // 削除失敗は無視
  }
}
