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
  .option('-m, --model <path>',         'ggml モデルファイルへのパス (デフォルト: ./models/ggml-base.bin)')
  .option('-b, --whisper-bin <path>',   'whisper.cpp バイナリへのパス (デフォルト: OS 自動判定)')
  .option('-l, --language <lang>',      '言語コード ja / en など (デフォルト: ja)')
  .option('-o, --output <dir>',         '文字起こし結果の出力ディレクトリ (デフォルト: ./outputs)')
  .option('--vad <mode>',               'VAD 感度 0-3 (デフォルト: 2)')
  .option('--threads <n>',              'whisper.cpp の推論スレッド数 (デフォルト: CPU/2)')
  .option('--queue-size <n>',           'SessionQueue の最大保持件数 (デフォルト: 8)')
  .option('--concurrency <n>',          'whisper Worker の並列数 (デフォルト: 1)')
  .option('--device <id>',              'マイクデバイス ID (例: hw:1,0)')
  .option('--max-segment <seconds>',    '長時間発話を分割する秒数 (デフォルト: 30)')
  .option('--segment-overlap <seconds>','セグメント間のオーバーラップ秒数 (デフォルト: 0.3)')
  .option('--log-dir <dir>',            'ログ出力ディレクトリ (デフォルト: ./logs)')
  .option('--log-level <level>',        'ログレベル DEBUG/INFO/WARN/ERROR (デフォルト: INFO)')
  .option('--log-max-mb <n>',           'ログ 1 ファイルの最大サイズ (MB, デフォルト: 10)')
  .option('--log-max-files <n>',        '保持するログファイル数 (デフォルト: 7)')
  .option('--no-log-console',           'ログをコンソールに出さない')
  .option('--no-color',                 'カラー出力を無効化する')
  .action(async (opts) => {
    // commander オプションを環境変数に転写してから、それらを参照するモジュールを動的 import する。
    // こうすると CLI 引数 > 環境変数 > デフォルト の優先順位で設定が反映される。
    if (opts.maxSegment       !== undefined) process.env.MAX_SEGMENT_SECONDS     = String(opts.maxSegment);
    if (opts.segmentOverlap   !== undefined) process.env.SEGMENT_OVERLAP_SECONDS = String(opts.segmentOverlap);
    if (opts.logDir           !== undefined) process.env.LOG_DIR                 = String(opts.logDir);
    if (opts.logLevel         !== undefined) process.env.LOG_LEVEL               = String(opts.logLevel).toUpperCase();
    if (opts.logMaxMb         !== undefined) process.env.LOG_MAX_MB              = String(opts.logMaxMb);
    if (opts.logMaxFiles      !== undefined) process.env.LOG_MAX_FILES           = String(opts.logMaxFiles);
    if (opts.logConsole === false)           process.env.LOG_CONSOLE             = 'false';
    if (opts.color === false)                process.env.NO_COLOR                = '1';

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

program
  .command('setup-whisper')
  .description('whisper.cpp を git clone して cmake でビルドする (cmake が無ければ自動 DL)')
  .option('--dir <path>',            'clone 先ディレクトリ (デフォルト: ./whisper.cpp)')
  .option('--repo <url>',            'リポジトリ URL (デフォルト: 公式)')
  .option('--branch <name>',         'チェックアウトするブランチ / タグ')
  .option('--rebuild',               '既存の build/ を削除してビルドし直す')
  .option('--pull',                  '既に clone 済みの場合に git pull で更新する')
  .option('--cmake-version <ver>',   '自動 DL する cmake のバージョン (デフォルト: 3.31.5)')
  .option('--no-auto-cmake',         'cmake が無くても自動ダウンロードしない')
  .action(async (opts) => {
    const { runSetupWhisper } = await import('../commands/setup-whisper');
    try {
      await runSetupWhisper(opts);
    } catch (err) {
      console.error('setup-whisper 失敗:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error('CLI 実行エラー:', err);
  process.exit(1);
});
