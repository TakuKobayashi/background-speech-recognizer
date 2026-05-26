import * as fs from 'fs';
import * as path from 'path';

export interface ListModelsOptions {
  dest?: string;
}

export function runListModels(opts: ListModelsOptions): void {
  const dir = opts.dest ?? './models';
  if (!fs.existsSync(dir)) {
    console.log(`models ディレクトリが存在しません: ${dir}`);
    console.log('npm run download-model -- base でモデルをダウンロードできます');
    return;
  }

  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('ggml-') && f.endsWith('.bin'))
    .map(f => ({
      name: f,
      size: fs.statSync(path.join(dir, f)).size,
      mtime: fs.statSync(path.join(dir, f)).mtime,
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  if (files.length === 0) {
    console.log(`${dir} にモデルファイルがありません`);
    console.log('npm run download-model -- base でダウンロードできます');
    return;
  }

  console.log(`\nインストール済みモデル (${dir}):`);
  console.log('─'.repeat(70));
  for (const f of files) {
    console.log(`  ${f.name.padEnd(34)} ${formatBytes(f.size).padStart(10)}  ${f.mtime.toISOString().slice(0, 19)}`);
  }
  console.log('─'.repeat(70));
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
