import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync, execSync, spawn, spawnSync, type ChildProcessByStdio } from 'child_process';
import { Readable } from 'stream';
import { DEFAULT_AUDIO_FORMAT, type AudioFormat } from './utils';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MACOS   = process.platform === 'darwin';
export const IS_LINUX   = process.platform === 'linux';

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
export function getMicConfig(format: AudioFormat, deviceId?: string): Record<string, string> {
  const base: Record<string, string> = {
    rate: String(format.sampleRate),
    channels: String(format.channels),
    encoding: 'signed-integer',
    bitwidth: String(format.bitDepth),
    endian: 'little',
    fileType: 'raw',
  };
  if (deviceId) {
    base.device = deviceId;
  }
  return base;
}

export interface AudioCaptureProcess {
  process: ChildProcessByStdio<null, Readable, Readable>;
  command: string;
  args: string[];
}

/**
 * Start audio capture as normalized raw PCM.
 *
 * The `mic` package uses a Windows SoX command that writes `-p` pipe output.
 * That is not guaranteed to be headerless mono PCM, while the rest of this
 * application treats incoming chunks as raw S16LE. Spawn SoX/arecord directly
 * so saved WAV files and VAD always see the same format.
 */
export function startAudioCapture(format: AudioFormat, deviceId?: string): AudioCaptureProcess {
  const bitDepth = String(format.bitDepth);
  const channels = String(format.channels);
  const rate = String(format.sampleRate);

  if (IS_LINUX) {
    const args = [
      '-q',
      ...(deviceId ? ['-D', deviceId] : []),
      '-c', channels,
      '-r', rate,
      '-f', format.bitDepth === 16 ? 'S16_LE' : `S${format.bitDepth}_LE`,
      '-t', 'raw',
      '-',
    ];
    return {
      process: spawn('arecord', args, { stdio: ['ignore', 'pipe', 'pipe'] }),
      command: 'arecord',
      args,
    };
  }

  const inputType = IS_WINDOWS ? 'waveaudio' : 'coreaudio';
  const inputDevice = deviceId ?? 'default';
  const args = [
    '-q',
    '-t', inputType,
    inputDevice,
    '-b', bitDepth,
    '--endian', 'little',
    '-c', channels,
    '-r', rate,
    '-e', 'signed-integer',
    '-t', 'raw',
    '-',
  ];

  return {
    process: spawn('sox', args, { stdio: ['ignore', 'pipe', 'pipe'] }),
    command: 'sox',
    args,
  };
}

export function resolveInputAudioFormat(deviceId?: string): AudioFormat {
  const envRate = parseSampleRate(process.env.MIC_SAMPLE_RATE);
  if (envRate) {
    return { ...DEFAULT_AUDIO_FORMAT, sampleRate: envRate };
  }

  const detectedRates = IS_LINUX
    ? detectLinuxSampleRates(deviceId)
    : detectSoxCompatibleSampleRates(deviceId);
  const sampleRate = choosePreferredSampleRate(detectedRates);
  return { ...DEFAULT_AUDIO_FORMAT, sampleRate };
}

function parseSampleRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 8000 && n <= 192000 ? Math.round(n) : undefined;
}

function choosePreferredSampleRate(rates: number[]): number {
  const unique = [...new Set(rates.filter(r => Number.isFinite(r) && r > 0))];
  if (unique.includes(48000)) return 48000;
  if (unique.includes(44100)) return 44100;
  const common = unique.filter(r => r >= 44100 && r <= 96000).sort((a, b) => Math.abs(a - 48000) - Math.abs(b - 48000));
  return common[0] ?? DEFAULT_AUDIO_FORMAT.sampleRate;
}

function detectLinuxSampleRates(deviceId?: string): number[] {
  const args = [
    ...(deviceId ? ['-D', deviceId] : []),
    '--dump-hw-params',
    '-f', 'S16_LE',
    '-c', String(DEFAULT_AUDIO_FORMAT.channels),
    '-d', '1',
    '/dev/null',
  ];

  try {
    const out = execFileSync('arecord', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
    return parseRatesFromText(out);
  } catch {
    return detectSoxCompatibleSampleRates(deviceId);
  }
}

function detectSoxCompatibleSampleRates(deviceId?: string): number[] {
  const candidates = [48000, 44100];
  const ok: number[] = [];
  for (const rate of candidates) {
    if (probeSoxRate(rate, deviceId)) ok.push(rate);
  }
  return ok;
}

function probeSoxRate(sampleRate: number, deviceId?: string): boolean {
  if (IS_LINUX) return false;
  const inputType = IS_WINDOWS ? 'waveaudio' : 'coreaudio';
  const inputDevice = deviceId ?? (IS_WINDOWS ? 'default' : 'default');
  const args = [
    '-q',
    '-t', inputType,
    inputDevice,
    '-b', String(DEFAULT_AUDIO_FORMAT.bitDepth),
    '--endian', 'little',
    '-c', String(DEFAULT_AUDIO_FORMAT.channels),
    '-r', String(sampleRate),
    '-e', 'signed-integer',
    '-t', 'raw',
    '-',
    'trim', '0', '0.05',
  ];
  const r = spawnSync('sox', args, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 2000 });
  return r.status === 0;
}

function parseRatesFromText(text: string): number[] {
  const rates = new Set<number>();
  const rateLine = text.split(/\r?\n/).find(line => /^\s*RATE:/.test(line));
  if (!rateLine) return [];

  const payload = rateLine.replace(/^\s*RATE:\s*/, '');
  for (const m of payload.matchAll(/\d+/g)) {
    const n = Number(m[0]);
    if (n >= 8000 && n <= 192000) rates.add(n);
  }
  return [...rates];
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
