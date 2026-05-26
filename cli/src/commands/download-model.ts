import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { URL } from 'url';

/**
 * whisper.cpp 公式 ggml モデル名
 * https://huggingface.co/ggerganov/whisper.cpp
 */
const MODEL_REGISTRY: Record<string, { size: string; description: string }> = {
  'tiny':         { size: '75 MB',  description: '最小・最速・精度低' },
  'tiny.en':      { size: '75 MB',  description: '英語専用・tinyベース' },
  'base':         { size: '142 MB', description: 'バランス型（標準）' },
  'base.en':      { size: '142 MB', description: '英語専用・baseベース' },
  'small':        { size: '466 MB', description: '高精度・実用的' },
  'small.en':     { size: '466 MB', description: '英語専用・smallベース' },
  'medium':       { size: '1.5 GB', description: '高精度・低速' },
  'medium.en':    { size: '1.5 GB', description: '英語専用・mediumベース' },
  'large-v1':     { size: '2.9 GB', description: '旧large版' },
  'large-v2':     { size: '2.9 GB', description: '安定版large' },
  'large-v3':     { size: '2.9 GB', description: '最新large・最高精度' },
  'large-v3-turbo': { size: '1.5 GB', description: 'large-v3の高速版' },
};

const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export interface DownloadOptions {
  dest?:      string;
  force?:     boolean;
  quantized?: string; // q4_0, q5_0, q8_0 など
  list?:      boolean;
}

export async function runDownloadModel(modelName: string | undefined, opts: DownloadOptions): Promise<void> {
  if (opts.list || !modelName) {
    printRegistry();
    if (!modelName) {
      process.exitCode = opts.list ? 0 : 1;
      if (!opts.list) console.error('\nモデル名を指定してください: npm run download-model -- base');
    }
    return;
  }

  if (!MODEL_REGISTRY[modelName]) {
    console.error(`不明なモデル名: ${modelName}`);
    printRegistry();
    process.exitCode = 1;
    return;
  }

  const fileName = opts.quantized
    ? `ggml-${modelName}-${opts.quantized}.bin`
    : `ggml-${modelName}.bin`;
  const url      = `${BASE_URL}/${fileName}`;
  const destDir  = opts.dest ?? './models';
  const destPath = path.join(destDir, fileName);

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  if (fs.existsSync(destPath) && !opts.force) {
    console.log(`✅ 既に存在: ${destPath}`);
    console.log(`   再ダウンロードする場合は --force`);
    return;
  }

  console.log(`📥 ダウンロード: ${url}`);
  console.log(`   保存先: ${destPath}`);

  await downloadWithRedirect(url, destPath);
  const size = fs.statSync(destPath).size;
  console.log(`\n✅ 完了 (${formatBytes(size)})`);
}

function printRegistry(): void {
  console.log('\n利用可能なモデル:');
  console.log('─'.repeat(70));
  for (const [name, info] of Object.entries(MODEL_REGISTRY)) {
    console.log(`  ${name.padEnd(18)} ${info.size.padStart(8)}  ${info.description}`);
  }
  console.log('─'.repeat(70));
  console.log('使用例:');
  console.log('  npm run download-model -- base');
  console.log('  npm run download-model -- large-v3 --quantized q5_0');
  console.log('  npm run download-model -- base --dest ./models --force');
}

function downloadWithRedirect(urlStr: string, dest: string, redirectsLeft = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.get({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      headers:  { 'User-Agent': 'whisper-local-cli' },
    }, (res) => {
      // リダイレクト追従
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          reject(new Error('リダイレクト回数の上限を超過'));
          return;
        }
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, urlStr).toString();
        res.resume();
        downloadWithRedirect(next, dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${urlStr}`));
        res.resume();
        return;
      }

      const total = parseInt(res.headers['content-length'] ?? '0', 10);
      let received = 0;
      const tmpPath = `${dest}.part`;
      const file = fs.createWriteStream(tmpPath);
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
            fs.renameSync(tmpPath, dest);
            renderProgress(received, total, true);
            resolve();
          } catch (e) { reject(e); }
        });
      });

      file.on('error', (err) => {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        reject(err);
      });
    });

    req.on('error', reject);
    req.setTimeout(60_000, () => { req.destroy(new Error('接続タイムアウト')); });
  });
}

function renderProgress(received: number, total: number, finalize = false): void {
  const ratio = total > 0 ? received / total : 0;
  const width = 30;
  const filled = Math.round(ratio * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct = (ratio * 100).toFixed(1).padStart(5);
  const recv = formatBytes(received);
  const tot  = total > 0 ? formatBytes(total) : '?';
  process.stdout.write(`\r  [${bar}] ${pct}%  ${recv} / ${tot}`);
  if (finalize) process.stdout.write('\n');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
