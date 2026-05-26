#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

program
  .name('whisper-cli')
  .description('ローカル完結リアルタイム音声文字起こし CLI (whisper.cpp + VAD)')
  .version('2.1.0');

// 各コマンドのモジュールは action 呼び出し時に require する。
// こうすることで download-model / doctor 等の軽量コマンドを実行する際に
// recorder / vad / node-vad など重い依存をロードせずに済む。

program
  .command('start')
  .description('マイク常駐の文字起こしを開始（録音→Queue→Worker→Whisper の完全非同期パイプライン）')
  .option('-m, --model <path>',       'ggml モデルファイルへのパス')
  .option('-b, --whisper-bin <path>', 'whisper.cpp バイナリへのパス')
  .option('-l, --language <lang>',    '言語コード (ja, en, …)')
  .option('-o, --output <dir>',       '出力ディレクトリ')
  .option('--vad <mode>',             'VAD 感度 0-3')
  .option('--threads <n>',            'whisper.cpp スレッド数')
  .option('--queue-size <n>',         'SessionQueue 最大件数')
  .option('--concurrency <n>',        'whisper Worker 並列数 (デフォルト 1)')
  .option('--device <id>',            'マイクデバイス ID')
  .action(async (opts) => {
    const { runStart } = await import('../commands/start');
    const { logger } = await import('../logger');
    try {
      await runStart(opts);
    } catch (err) {
      logger.error(`致命的エラー: ${String(err)}`);
      console.error('致命的エラー:', err);
      process.exit(1);
    }
  });

program
  .command('download-model [name]')
  .description('whisper.cpp 用 ggml モデルをダウンロード (例: base, small, large-v3)')
  .option('-d, --dest <dir>',     '保存先ディレクトリ', './models')
  .option('-f, --force',          '既存ファイルを上書きする')
  .option('-q, --quantized <q>',  '量子化バリアント (例: q5_0, q8_0)')
  .option('--list',               '利用可能なモデル一覧を表示する')
  .action(async (name, opts) => {
    const { runDownloadModel } = await import('../commands/download-model');
    try {
      await runDownloadModel(name, opts);
    } catch (err) {
      console.error('ダウンロード失敗:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('依存ツール・モデル・バイナリの状態を診断する')
  .option('-m, --model <path>',       'チェックするモデルファイルパス')
  .option('-b, --whisper-bin <path>', 'チェックする whisper.cpp バイナリパス')
  .action(async (opts) => {
    const { runDoctor } = await import('../commands/doctor');
    runDoctor(opts);
  });

program
  .command('list-models')
  .description('インストール済みモデルを一覧表示')
  .option('-d, --dest <dir>', 'モデルディレクトリ', './models')
  .action(async (opts) => {
    const { runListModels } = await import('../commands/list-models');
    runListModels(opts);
  });

if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error('CLI 実行エラー:', err);
  process.exit(1);
});
