/**
 * 互換用エントリ。
 * v2.1 で commander 化されており、本体は src/bin/cli.ts。
 * `node dist/index.js` を実行された場合は start コマンドにフォールバックする。
 */
import { runStart } from './commands/start';
import { logger } from './logger';

runStart({}).catch((err: unknown) => {
  logger.error(`致命的エラー: ${String(err)}`);
  console.error('致命的エラー:', err);
  process.exit(1);
});
