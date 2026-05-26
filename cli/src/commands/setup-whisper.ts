import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { IS_WINDOWS } from '../platform';

const REPO_DEFAULT = 'https://github.com/ggerganov/whisper.cpp.git';

export interface SetupWhisperOptions {
  dir?:     string;
  repo?:    string;
  branch?:  string;
  rebuild?: boolean;
  pull?:    boolean;
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

  requireCommand('git',   'git をインストールしてください: https://git-scm.com/');
  requireCommand('cmake', 'cmake をインストールしてください: https://cmake.org/download/');

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
  run('cmake', ['-B', 'build', '-DWHISPER_BUILD_EXAMPLES=ON'], { cwd: cloneDir });

  console.log('\n🔨 cmake build (Release)');
  const buildArgs = ['--build', 'build', '--config', 'Release'];
  if (!IS_WINDOWS) buildArgs.push('-j', String(os.cpus().length));
  run('cmake', buildArgs, { cwd: cloneDir });

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

function requireCommand(name: string, hint: string): void {
  const result = spawnSync(name, ['--version'], { stdio: 'ignore', shell: IS_WINDOWS });
  if (result.status !== 0) {
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
