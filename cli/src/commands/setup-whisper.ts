import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { URL } from 'node:url';

import { IS_WINDOWS } from '../platform';

const REPO_DEFAULT          = 'https://github.com/ggerganov/whisper.cpp.git';
const CMAKE_DEFAULT_VERSION = '3.31.5';
const CMAKE_RELEASE_BASE    = 'https://github.com/Kitware/CMake/releases/download';

export interface SetupWhisperOptions {
  dir?:           string;
  repo?:          string;
  branch?:        string;
  rebuild?:       boolean;
  pull?:          boolean;
  cmakeVersion?:  string;
  noAutoCmake?:   boolean;
}

export async function runSetupWhisper(opts: SetupWhisperOptions): Promise<void> {
  const cloneDir = path.resolve(process.cwd(), opts.dir ?? './whisper.cpp');
  const repoUrl  = opts.repo   ?? REPO_DEFAULT;
  const branch   = opts.branch ?? null;

  console.log('🛠  whisper.cpp セットアップ');
  console.log('─'.repeat(60));
  console.log(`  リポジトリ : ${repoUrl}`);
  console.log(`  clone 先   : ${cloneDir}`);
  if (branch) console.log(`  branch     : ${branch}`);
  console.log('─'.repeat(60));

  requireCommand('git', 'git をインストールしてください: https://git-scm.com/');
  const cmakeCmd = await ensureCmake(opts);

  if (fs.existsSync(cloneDir)) {
    console.log(`\n📁 既存ディレクトリを検出: ${cloneDir}`);
    if (opts.pull) {
      console.log('   git pull で更新します…');
      run('git', ['-C', cloneDir, 'pull', '--ff-only']);
    } else {
      console.log('   そのまま使用します (更新したい場合は --pull)');
    }
  } else {
    console.log(`\n📥 git clone: ${repoUrl}`);
    const cloneArgs = ['clone', '--depth', '1'];
    if (branch) cloneArgs.push('--branch', branch);
    cloneArgs.push(repoUrl, cloneDir);
    run('git', cloneArgs);
  }

  if (branch && !opts.pull) {
    console.log(`\n🔀 ブランチ切替: ${branch}`);
    run('git', ['-C', cloneDir, 'fetch', '--depth', '1', 'origin', branch]);
    run('git', ['-C', cloneDir, 'checkout', branch]);
  }

  const buildDir = path.join(cloneDir, 'build');
  if (opts.rebuild && fs.existsSync(buildDir)) {
    console.log(`\n🧹 既存ビルドを削除: ${buildDir}`);
    fs.rmSync(buildDir, { recursive: true, force: true });
  }

  console.log('\n🧰 cmake configure');
  run(cmakeCmd, ['-B', 'build', '-DWHISPER_BUILD_EXAMPLES=ON'], { cwd: cloneDir });

  console.log('\n🔨 cmake build (Release)');
  const buildArgs = ['--build', 'build', '--config', 'Release'];
  if (!IS_WINDOWS) buildArgs.push('-j', String(os.cpus().length));
  run(cmakeCmd, buildArgs, { cwd: cloneDir });

  const binPath = IS_WINDOWS
    ? path.join(cloneDir, 'build', 'bin', 'Release', 'whisper-cli.exe')
    : path.join(cloneDir, 'build', 'bin', 'whisper-cli');

  if (!fs.existsSync(binPath)) {
    throw new Error(`ビルドは終わりましたがバイナリが見つかりません: ${binPath}`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`✅ 完了: ${binPath}`);
  console.log('─'.repeat(60));
  console.log('次のステップ:');
  console.log('  npm run cli -- doctor                  # 環境チェック');
  console.log('  npm run cli -- download-model base     # モデル取得');
  console.log('  npm run cli -- start                   # 起動');
}

// ============================================================
// cmake: PATH を探し、無ければ公式リリースから portable 版を取得
// ============================================================

async function ensureCmake(opts: SetupWhisperOptions): Promise<string> {
  // 1) PATH に cmake があれば素直にそれを使う
  if (commandWorks('cmake')) {
    return 'cmake';
  }

  // 2) vendor/cmake/ 配下に既にダウンロード済みのものがあれば使う
  const existing = findVendorCmake();
  if (existing) {
    console.log(`\n📦 既存の vendor cmake を再利用: ${existing}`);
    return existing;
  }

  // 3) ユーザーが自動 DL を明示的に拒否しているなら止める
  if (opts.noAutoCmake) {
    throw new Error(
      'cmake が見つかりません。--no-auto-cmake が指定されているので自動ダウンロードは行いません。\n' +
      '  → cmake を手動でインストール: https://cmake.org/download/'
    );
  }

  // 4) 公式リリースから portable 版を取得
  const version = opts.cmakeVersion ?? CMAKE_DEFAULT_VERSION;
  console.log(`\n⚠️  cmake が PATH に見つかりません。公式リリース v${version} を自動ダウンロードします…`);
  return await downloadAndInstallCmake(version);
}

function findVendorCmake(): string | null {
  const vendorDir = path.resolve(process.cwd(), 'vendor', 'cmake');
  if (!fs.existsSync(vendorDir)) return null;

  // vendor/cmake/cmake-X.Y.Z-<os>-<arch>/ の中を探す
  const subdirs = fs.readdirSync(vendorDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(vendorDir, d.name));

  const candidates = subdirs.flatMap(sub => [
    path.join(sub, 'bin', IS_WINDOWS ? 'cmake.exe' : 'cmake'),       // Windows / Linux
    path.join(sub, 'CMake.app', 'Contents', 'bin', 'cmake'),         // macOS
  ]);

  return candidates.find(p => fs.existsSync(p)) ?? null;
}

async function downloadAndInstallCmake(version: string): Promise<string> {
  const { url, archive, extractedDirName } = resolveCmakeAsset(version);
  const vendorDir  = path.resolve(process.cwd(), 'vendor', 'cmake');
  const archivePath = path.join(vendorDir, archive);

  fs.mkdirSync(vendorDir, { recursive: true });

  if (fs.existsSync(archivePath)) {
    console.log(`   📦 既存のアーカイブを再利用: ${archivePath}`);
  } else {
    console.log(`   URL  : ${url}`);
    console.log(`   保存 : ${archivePath}`);
    await httpDownload(url, archivePath);
  }

  console.log(`\n📂 展開中: ${archive}`);
  extractArchive(archivePath, archive, vendorDir);

  // アーカイブはもう要らない
  try { fs.unlinkSync(archivePath); } catch { /* ignore */ }

  const extractedDir = path.join(vendorDir, extractedDirName);
  if (!fs.existsSync(extractedDir)) {
    throw new Error(`展開後ディレクトリが見つかりません: ${extractedDir}`);
  }

  const cmakeBin = findVendorCmake();
  if (!cmakeBin) {
    throw new Error('cmake のダウンロードと展開は完了しましたが、実行ファイルが見つかりません');
  }

  if (!IS_WINDOWS) {
    try { fs.chmodSync(cmakeBin, 0o755); } catch { /* ignore */ }
  }

  console.log(`✅ cmake インストール完了: ${cmakeBin}`);
  return cmakeBin;
}

function resolveCmakeAsset(version: string): { url: string; archive: string; extractedDirName: string } {
  // 公式リリースアセット命名規則: cmake-<ver>-<os>-<arch>.<ext>
  let osPart: string;
  let archPart: string;
  let ext: string;

  if (IS_WINDOWS) {
    osPart  = 'windows';
    archPart = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    ext     = 'zip';
  } else if (process.platform === 'darwin') {
    osPart  = 'macos';
    archPart = 'universal';
    ext     = 'tar.gz';
  } else {
    osPart  = 'linux';
    archPart = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    ext     = 'tar.gz';
  }

  const base    = `cmake-${version}-${osPart}-${archPart}`;
  const archive = `${base}.${ext}`;
  return {
    url:              `${CMAKE_RELEASE_BASE}/v${version}/${archive}`,
    archive,
    extractedDirName: base,
  };
}

// ============================================================
// 共通ユーティリティ
// ============================================================

function commandWorks(name: string): boolean {
  const result = spawnSync(name, ['--version'], { stdio: 'ignore', shell: IS_WINDOWS });
  return result.status === 0;
}

function requireCommand(name: string, hint: string): void {
  if (!commandWorks(name)) {
    throw new Error(`${name} が見つかりません。${hint}`);
  }
}

function run(cmd: string, args: string[], options: SpawnSyncOptions = {}): void {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: IS_WINDOWS, // Windows では .cmd / .exe シムを通すため shell:true が必要
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} がコード ${result.status} で終了しました`);
  }
}

/**
 * .zip / .tar.gz アーカイブを展開する。
 *
 * Windows では PATH 先頭が Git Bash 同梱の GNU tar になっていることがあり、
 * GNU tar は .zip を読めない & `C:\...` をリモートホストと誤解する。
 * Windows 10+ 標準同梱の `%SystemRoot%\System32\tar.exe` (bsdtar/libarchive) は
 * .zip / .tar.gz の両方を扱えるので、存在すればそれを優先して使う。
 */
function extractArchive(_archivePath: string, archive: string, destDir: string): void {
  let tarBin = 'tar';
  if (IS_WINDOWS) {
    const systemTar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(systemTar)) tarBin = systemTar;
  }
  console.log(`  $ ${tarBin} -xf ${archive}`);
  const result = spawnSync(tarBin, ['-xf', archive], {
    stdio: 'inherit',
    cwd:   destDir,
    shell: false, // 絶対パスで呼ぶので shell 経由は不要
  });
  if (result.status !== 0) {
    throw new Error(`tar (展開) がコード ${result.status} で終了しました`);
  }
}

function httpDownload(urlStr: string, dest: string, redirectsLeft = 8): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.get({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      headers:  { 'User-Agent': 'whisper-local-cli/setup-whisper' },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          reject(new Error('リダイレクト回数の上限を超過'));
          return;
        }
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, urlStr).toString();
        res.resume();
        httpDownload(next, dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}: ${urlStr}`));
        return;
      }

      const total = parseInt(res.headers['content-length'] ?? '0', 10);
      let received = 0;
      const tmp  = `${dest}.part`;
      const file = fs.createWriteStream(tmp);
      let lastLog = 0;

      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastLog > 300) {
          lastLog = now;
          renderProgress(received, total);
        }
      });

      res.pipe(file);

      file.on('finish', () => {
        file.close((err) => {
          if (err) { reject(err); return; }
          try {
            fs.renameSync(tmp, dest);
            renderProgress(received, total, true);
            resolve();
          } catch (e) { reject(e); }
        });
      });

      file.on('error', (err) => {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        reject(err);
      });
    });

    req.on('error', reject);
    req.setTimeout(120_000, () => { req.destroy(new Error('接続タイムアウト')); });
  });
}

function renderProgress(received: number, total: number, finalize = false): void {
  const ratio  = total > 0 ? received / total : 0;
  const width  = 30;
  const filled = Math.round(ratio * width);
  const bar    = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct    = (ratio * 100).toFixed(1).padStart(5);
  const recv   = formatBytes(received);
  const tot    = total > 0 ? formatBytes(total) : '?';
  process.stdout.write(`\r  [${bar}] ${pct}%  ${recv} / ${tot}`);
  if (finalize) process.stdout.write('\n');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
