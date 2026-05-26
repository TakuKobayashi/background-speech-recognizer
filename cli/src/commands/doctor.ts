import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { checkAudioDependency, getDefaultWhisperBin, IS_WINDOWS, IS_LINUX, IS_MACOS } from '../platform';

interface Check {
  name: string;
  ok:   boolean;
  hint?: string;
  detail?: string;
}

export interface DoctorOptions {
  model?:      string;
  whisperBin?: string;
}

export function runDoctor(opts: DoctorOptions): void {
  const checks: Check[] = [];

  // Node.js
  const nodeVer = process.versions.node;
  const majorVer = parseInt(nodeVer.split('.')[0] ?? '0', 10);
  checks.push({
    name: 'Node.js >= 18',
    ok:   majorVer >= 18,
    detail: `node ${nodeVer}`,
    hint: majorVer < 18 ? 'https://nodejs.org/ から最新版を入れてください' : undefined,
  });

  // OS
  const osName = IS_WINDOWS ? 'Windows' : IS_LINUX ? 'Linux' : IS_MACOS ? 'macOS' : process.platform;
  checks.push({ name: 'OS', ok: true, detail: osName });

  // Audio backend (sox / arecord)
  const audio = checkAudioDependency();
  checks.push({
    name: '音声入力ツール (sox/arecord)',
    ok:   audio.ok,
    detail: audio.message,
    hint: audio.ok ? undefined :
      IS_LINUX ? 'sudo apt install alsa-utils' :
      IS_WINDOWS ? 'https://sourceforge.net/projects/sox/ → PATH 通す' :
                   'brew install sox',
  });

  // whisper.cpp binary
  const whisperBin = opts.whisperBin ?? process.env.WHISPER_BIN ?? getDefaultWhisperBin();
  const binExists = fs.existsSync(whisperBin);
  let binVer = '';
  if (binExists) {
    try {
      binVer = execSync(`"${whisperBin}" --help`, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
        .toString().split('\n').slice(0, 1).join('').trim();
    } catch { /* ignore */ }
  }
  checks.push({
    name: 'whisper.cpp バイナリ',
    ok:   binExists,
    detail: binExists ? `${whisperBin} ${binVer ? '— ' + binVer.slice(0, 40) : ''}` : `見つかりません: ${whisperBin}`,
    hint: !binExists ? 'README の whisper.cpp セットアップを参照' : undefined,
  });

  // Model file
  const modelPath = opts.model ?? process.env.WHISPER_MODEL ?? './models/ggml-base.bin';
  const modelExists = fs.existsSync(modelPath);
  let modelSize = '';
  if (modelExists) {
    try { modelSize = formatBytes(fs.statSync(modelPath).size); } catch { /* ignore */ }
  }
  checks.push({
    name: 'モデルファイル',
    ok:   modelExists,
    detail: modelExists ? `${modelPath} (${modelSize})` : `見つかりません: ${modelPath}`,
    hint: !modelExists ? 'npm run download-model -- base' : undefined,
  });

  // Models directory listing
  const modelsDir = path.dirname(modelPath);
  if (fs.existsSync(modelsDir)) {
    const found = fs.readdirSync(modelsDir).filter(f => f.startsWith('ggml-') && f.endsWith('.bin'));
    checks.push({
      name: 'インストール済みモデル',
      ok:   found.length > 0,
      detail: found.length > 0 ? found.join(', ') : '(空)',
    });
  }

  // Outputs / logs dirs
  for (const dir of ['./outputs', './logs']) {
    const exists = fs.existsSync(dir);
    checks.push({
      name: `ディレクトリ ${dir}`,
      ok:   true,
      detail: exists ? '存在' : '起動時に自動作成',
    });
  }

  // Render
  console.log('\n🩺 whisper-cli doctor');
  console.log('─'.repeat(70));
  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${mark} ${c.name.padEnd(34)} ${c.detail ?? ''}`);
    if (!c.ok) failed++;
    if (c.hint) console.log(`      \x1b[33m→ ${c.hint}\x1b[0m`);
  }
  console.log('─'.repeat(70));
  if (failed === 0) {
    console.log('\x1b[32m全てのチェックを通過しました ✅\x1b[0m');
  } else {
    console.log(`\x1b[31m${failed} 件の問題があります\x1b[0m`);
    process.exitCode = 1;
  }
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
