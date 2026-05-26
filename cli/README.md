# whisper-local-cli v2.1

ローカル完結型リアルタイム音声文字起こし CLI
**Windows 11 / Linux / macOS 対応・24 時間 365 日常駐運用対応**

v2.1 の主な追加点:

- **完全非同期パイプライン (worker_threads)** — 録音 → Queue → Worker → whisper.cpp を別スレッド化し、長時間録音中も UI / VAD / 録音処理が一切ブロックされない
- **長時間録音対応 (セグメント分割)** — 沈黙で切れない長い発話を `MAX_SEGMENT_SECONDS` ごとに自動分割して Queue に流し、オーバーラップ付きで連続文字起こし
- **commander によるサブコマンド化** — `start` / `download-model` / `doctor` / `list-models`
- **`npm run download-model` だけでモデル取得** — huggingface から ggml-*.bin を直接ダウンロード

---

## アーキテクチャ (v2.1 完全非同期パイプライン)

```
┌──────────────┐   PCM    ┌──────────────┐   PCM    ┌──────────────┐
│  Mic (sox /  │──chunks──▶│   Recorder   │──split──▶│ SessionQueue │
│   arecord)   │  10ms 単位 │  VAD + 分割  │  segments│  (有界・GC)  │
└──────────────┘          └──────────────┘          └──────┬───────┘
                                                            │ dequeue
                                                            ▼
                                                    ┌──────────────┐
                                                    │  Dispatcher  │
                                                    │ (main loop)  │
                                                    └──────┬───────┘
                                                            │ postMessage
                                                            │ (Transferable)
                                                            ▼
                                                    ┌──────────────┐    spawn
                                                    │ Worker Pool  │──────────▶ whisper.cpp
                                                    │ (worker_     │           子プロセス
                                                    │  threads)    │
                                                    └──────┬───────┘
                                                            │ result
                                                            ▼
                                                       *.txt / *.wav
```

- **メインスレッド**: マイク受信 / VAD / セグメント分割 / Queue 管理だけ
- **Worker スレッド (1 個以上)**: whisper.cpp サブプロセスの起動・I/O・テキスト抽出
- **転送**: PCM Buffer を `ArrayBuffer` Transferable として渡すのでコピーコストなし
- **長時間発話**: `MAX_SEGMENT_SECONDS` (デフォルト 30 秒) 経過したら、その時点までのチャンクを「中間セグメント」として Queue に流し、`SEGMENT_OVERLAP_SECONDS` 分のオーバーラップを付けて録音継続
- **並列度**: `--concurrency N` で whisper Worker を複数立ち上げて並列に文字起こし

---

## 必要環境

### Windows 11
| ツール | 入手先 |
|---|---|
| Node.js 18+ | https://nodejs.org |
| Windows Build Tools | `npm install -g windows-build-tools` (管理者) |
| CMake | https://cmake.org/download/ |
| Visual Studio 2022 Build Tools | https://aka.ms/vs/17/release/vs_BuildTools.exe |
| SoX (オーディオ) | https://sourceforge.net/projects/sox/ |

### Linux (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install -y nodejs npm build-essential cmake libasound2-dev alsa-utils
```

### macOS
```bash
brew install node cmake sox
```

---

## セットアップ

### 1. 依存パッケージのインストール
```bash
pnpm install   # または npm install
```

### 2. TypeScript のビルド
```bash
npm run build
```

### 3. whisper.cpp のビルド

**Linux / macOS:**
```bash
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build --config Release -j$(nproc)
cd ..
```

**Windows (PowerShell 管理者):**
```powershell
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build --config Release
cd ..
```

バイナリ生成場所:
- Linux/macOS: `whisper.cpp/build/bin/whisper-cli`
- Windows: `whisper.cpp/build/bin/Release/whisper-cli.exe`

### 4. モデルのダウンロード (新機能)

v2.1 では CLI から huggingface の ggml モデルを直接取得できます。

> ⚠️ **Windows PowerShell の注意**
> PowerShell は `npm run xxx -- --flag` の `--` を独自に解釈して、後続の `--xxx` フラグを取り除いてしまいます。
> その結果 `--dest` / `--quantized` / `--list` などのフラグが届かず「too many arguments」「モデル名を指定してください」のように失敗します。
> **位置引数だけ**を渡すなら `npm run download-model -- base` でも動作しますが、フラグを併用する場合は次の「直接実行」形式を使ってください。

**位置引数のみ (どの環境でも動作):**

```bash
# base モデル (推奨・142MB)
npm run download-model -- base

# 別モデル
npm run download-model -- small
npm run download-model -- large-v3
npm run download-model -- large-v3-turbo
```

**フラグ付き — `npx tsx` で直接実行 (PowerShell / bash 共通で動作):**

```bash
# 量子化バージョン (容量小)
npx tsx src/bin/cli.ts download-model large-v3 --quantized q5_0

# 保存先指定 / 上書き
npx tsx src/bin/cli.ts download-model base --dest ./models --force

# 利用可能モデル一覧
npx tsx src/bin/cli.ts download-model --list
```

> ビルド済みの場合は `npx tsx src/bin/cli.ts` の代わりに `node dist/bin/cli.js` でも同じことができます。

### 5. 起動診断

```bash
# どちらでも可
npm run doctor
npx tsx src/bin/cli.ts doctor
```

各種依存（Node.js / sox/arecord / whisper.cpp バイナリ / モデルファイル / 出力ディレクトリ）をまとめてチェックし、不足があれば修正手順を表示します。

特定のモデル / バイナリパスをチェックする場合 (フラグ付きなので直接実行):

```bash
npx tsx src/bin/cli.ts doctor --model ./models/ggml-small.bin --whisper-bin ./whisper.cpp/build/bin/whisper-cli
```

### 6. 起動

引数なしのデフォルト起動:

```bash
npm start                  # 通常起動 (要 build)
npm run start:gc           # GC 最適化 (24/7 運用推奨・要 build)
npm run dev                # tsx で TS を直接実行 (開発)
```

オプション付きで起動する場合は PowerShell では `npm start -- --flag` が機能しないため、直接実行してください:

```bash
# ビルドなしで開発実行 (どの環境でも動作)
npx tsx src/bin/cli.ts start --model ./models/ggml-small.bin --concurrency 2

# ビルド後の本番起動
node dist/bin/cli.js start --model ./models/ggml-small.bin --concurrency 2

# 24/7 運用 (GC ヒント有効)
node --expose-gc dist/bin/cli.js start --concurrency 2
```

---

## CLI コマンド一覧

v2.1 より commander を導入し、サブコマンド形式になりました。CLI は次の 3 通りの方法で起動できます。

| 起動方法 | 用途 | フラグ引数 |
|---|---|---|
| `npx tsx src/bin/cli.ts <command>` | TypeScript を直接実行 (開発・PowerShell でも安全) | ✅ そのまま |
| `node dist/bin/cli.js <command>`   | ビルド後の本番実行                       | ✅ そのまま |
| `npm run <script> -- <args>`       | npm script 経由                            | ⚠️ PowerShell では `--flag` が消える |

```bash
# 推奨: 直接実行 (フラグ付きでも動く)
npx tsx src/bin/cli.ts <command> [options]
node dist/bin/cli.js <command> [options]
```

| コマンド | 説明 |
|---|---|
| `start`          | マイク常駐の文字起こしを開始 (完全非同期パイプライン) |
| `download-model` | ggml モデルを huggingface からダウンロード |
| `doctor`         | 依存関係 / バイナリ / モデルの診断 |
| `list-models`    | インストール済みモデル一覧 |
| `help`           | ヘルプ表示 |

### `start` のオプション

| オプション | 説明 | デフォルト |
|---|---|---|
| `-m, --model <path>`       | ggml モデルファイル                  | `./models/ggml-base.bin` |
| `-b, --whisper-bin <path>` | whisper.cpp バイナリ                | OS 自動判定 |
| `-l, --language <lang>`    | 言語コード (`ja`, `en`, …)          | `ja` |
| `-o, --output <dir>`       | 出力ディレクトリ                       | `./outputs` |
| `--vad <0-3>`              | VAD 感度                            | `2` |
| `--threads <n>`            | whisper.cpp スレッド数               | CPU/2 |
| `--queue-size <n>`         | SessionQueue 最大件数                | `8` |
| `--concurrency <n>`        | whisper Worker 並列数                | `1` |
| `--device <id>`            | マイクデバイス ID                     | (自動) |

### 使用例 (PowerShell / bash どちらでも動く)

```bash
# フル機能のヘルプ
npx tsx src/bin/cli.ts help
npx tsx src/bin/cli.ts help start
npx tsx src/bin/cli.ts start --help

# 起動 (small モデル・並列 2)
npx tsx src/bin/cli.ts start --model ./models/ggml-small.bin --concurrency 2

# 診断
npx tsx src/bin/cli.ts doctor

# モデル一覧
npx tsx src/bin/cli.ts list-models
```

### npm script で動く・動かないコマンド

```bash
# ✅ 引数なし: どの環境でも動く
npm start
npm run start:gc
npm run dev
npm run doctor
npm run models
npm run build

# ✅ 位置引数だけ: どの環境でも動く
npm run download-model -- base
npm run download-model -- large-v3

# ⚠️ Windows PowerShell では --flag が消える
npm run download-model -- --list                    # ← --list が消える
npm run download-model -- base --dest ./models      # ← --dest が消える
npm start -- --model ./models/ggml-small.bin        # ← --model が消える
# → PowerShell の場合は上記の「npx tsx src/bin/cli.ts ...」形式に置き換えてください
# → bash / zsh / Git Bash では問題なく動作します
```

---

## 環境変数

CLI オプションが優先されますが、未指定時は環境変数を読みます。

| 変数 | デフォルト | 説明 |
|---|---|---|
| `WHISPER_BIN`             | OS 別自動設定           | whisper.cpp バイナリパス |
| `WHISPER_MODEL`           | `./models/ggml-base.bin`| モデルファイルパス |
| `WHISPER_LANG`            | `ja`                    | 言語コード |
| `WHISPER_THREADS`         | CPU コア数/2            | 推論スレッド数 |
| `OUTPUT_DIR`              | `./outputs`             | 出力ディレクトリ |
| `VAD_MODE`                | `2`                     | VAD 感度 (0〜3) |
| `QUEUE_SIZE`              | `8`                     | セッションキュー最大数 |
| `WORKER_CONCURRENCY`      | `1`                     | whisper Worker 並列数 |
| `MAX_SEGMENT_SECONDS`     | `30`                    | 長時間発話のセグメント分割閾値 |
| `SEGMENT_OVERLAP_SECONDS` | `0.3`                   | セグメント間オーバーラップ |
| `MIC_DEVICE`              | (未設定)                | マイクデバイス ID |
| `LOG_DIR`                 | `./logs`                | ログディレクトリ |
| `LOG_MAX_MB`              | `10`                    | 1 ファイルの最大サイズ (MB) |
| `LOG_MAX_FILES`           | `7`                     | 保持するログファイル数 |
| `LOG_LEVEL`               | `INFO`                  | ログレベル (DEBUG/INFO/WARN/ERROR) |
| `LOG_CONSOLE`             | `true`                  | コンソール出力 (false で抑制) |
| `NO_COLOR`                | (未設定)                | 設定するとカラー出力を無効化 |

**Windows での設定例:**
```powershell
$env:WHISPER_MODEL = ".\models\ggml-small.bin"
$env:WORKER_CONCURRENCY = "2"
npm start
```

**Linux での設定例:**
```bash
WHISPER_LANG=en MAX_SEGMENT_SECONDS=20 WORKER_CONCURRENCY=2 npm run start:gc
```

---

## ディレクトリ構成 (v2.1)

```
whisper-local-cli/
├── src/
│   ├── bin/
│   │   └── cli.ts                 # [NEW] commander エントリ
│   ├── commands/
│   │   ├── start.ts               # [NEW] 常駐録音メインロジック
│   │   ├── download-model.ts      # [NEW] huggingface からモデル取得
│   │   ├── doctor.ts              # [NEW] 環境診断
│   │   └── list-models.ts         # [NEW] モデル一覧
│   ├── worker/
│   │   ├── transcriber-worker.ts  # [NEW] worker_thread 本体
│   │   └── transcriber-pool.ts    # [NEW] Worker Pool マネージャ
│   ├── index.ts                   # 互換用エントリ (start にフォールバック)
│   ├── recorder.ts                # マイク録音＋VAD＋セグメント分割 (long-recording 対応)
│   ├── vad.ts                     # WebRTC VAD + エネルギーベース VAD
│   ├── transcriber.ts             # whisper.cpp subprocess
│   ├── utils.ts                   # WAV書き込み・BoundedBuffer 等
│   ├── platform.ts                # Windows/Linux 互換ユーティリティ
│   ├── logger.ts                  # ローテーションファイルロガー
│   ├── queue.ts                   # 有界セッションキュー
│   └── health.ts                  # ヘルスモニタリング
├── models/                # ggml モデル置き場 (download-model で自動作成)
├── outputs/               # 文字起こし結果 (.wav + .txt)
├── logs/                  # ログファイル (自動ローテーション)
├── whisper.cpp/           # whisper.cpp ソース
├── package.json
├── tsconfig.json
└── README.md
```

---

## 長時間録音の仕組み

v2.0 までは `MAX_RECORD_SECONDS = 60` を超えた録音は古いチャンクから捨てられていましたが、v2.1 では:

1. 録音中、PCM バッファの長さが `MAX_SEGMENT_SECONDS` (デフォルト 30 秒) に達したら、その時点までを「中間セグメント (segmentIndex=0, 1, 2, …)」として Queue に流す
2. 末尾 `SEGMENT_OVERLAP_SECONDS` (デフォルト 0.3 秒) を新しいバッファの先頭に複製し、録音は中断なく継続
3. 沈黙が検出されたら最後のセグメントを「最終セグメント」として Queue に流して voice_end
4. 各セグメントは独立に Worker Pool で並列文字起こし → ファイル名は `YYYYMMDD_HHMMSS_<segmentIndex>.{wav,txt}`

これにより、講演・会議など長時間の連続発話でもメモリを圧迫せず、録音と文字起こしが時間軸でずれずにキャッチアップできます。

---

## 24/7 運用ガイド

### systemd サービス化 (Linux)

```ini
# /etc/systemd/system/whisper-cli.service
[Unit]
Description=Whisper Local Transcriber
After=network.target sound.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/whisper-local-cli
ExecStart=/usr/bin/node --expose-gc dist/bin/cli.js start
Restart=always
RestartSec=5
Environment=WHISPER_LANG=ja
Environment=LOG_LEVEL=INFO
Environment=WORKER_CONCURRENCY=2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable whisper-cli
sudo systemctl start whisper-cli
sudo journalctl -u whisper-cli -f
```

### Windows サービス化 (NSSM)

```powershell
nssm install WhisperCLI "C:\Program Files\nodejs\node.exe"
nssm set WhisperCLI AppParameters "--expose-gc C:\path\to\dist\bin\cli.js start"
nssm set WhisperCLI AppDirectory "C:\path\to\whisper-local-cli"
nssm set WhisperCLI AppEnvironmentExtra "WHISPER_LANG=ja" "WORKER_CONCURRENCY=2"
nssm start WhisperCLI
```

---

## トラブルシューティング

### `npm run doctor` の結果を見る

ほとんどの起動失敗は `npm run doctor` で原因が判明します。

### Windows: `mic` がエラー

SoX がインストールされ PATH に追加されているか確認:
```powershell
sox --version
```

### Linux: `arecord: device not found`

```bash
arecord -l                # デバイス一覧

# Linux / bash の場合
npm start -- --device hw:1,0

# Windows PowerShell の場合 (npm script の -- が壊れるため直接実行)
npx tsx src/bin/cli.ts start --device hw:1,0
```

### `node-vad` ビルドエラー

```bash
sudo apt install python3 build-essential
npm install --build-from-source
```

node-vad がビルドできない場合でも、内蔵エネルギーベース VAD で動作します。

### モデルダウンロードが遅い / 失敗する

huggingface はリージョンによっては不安定です。`--force` で再試行できます (PowerShell の場合は `npm run download-model -- base --force` ではなく直接実行する):

```bash
npx tsx src/bin/cli.ts download-model base --force
```

または直接 `https://huggingface.co/ggerganov/whisper.cpp` から `ggml-*.bin` を `./models/` 配下に置けば手動でも動きます。

### メモリ使用量が増え続ける

```bash
npm run start:gc                  # GC ヒントを有効化
tail -f logs/whisper-cli-*.log | grep Health
```

長時間発話で問題が出る場合は `MAX_SEGMENT_SECONDS=15` のように小さくしてセグメントを細かく区切ってください。

---

## 修正済み問題一覧 (v2.0 までの履歴)

| # | 問題 | 修正内容 |
|---|---|---|
| 1 | `setRawMode` Windows クラッシュ | `trySetRawMode()` で TTY 判定後のみ呼び出し |
| 2 | node-vad VOICE 値バグ（2→3） | `NODE_VAD_VOICE_EVENT=3` に修正・定数取得ロジック追加 |
| 3 | セッションキュー未実装 | `SessionQueue`（有界・ドロップ付き）を新規実装 |
| 4 | `proc.kill('SIGKILL')` Windows 非対応 | `killProcess()` で `taskkill /F /PID` を使用 |
| 5 | 子プロセスゾンビ化 | `activeProcs` グローバルセットで exit 時に全 kill |
| 6 | ログローテーション欠如 | `RotatingLogger`（日次+サイズ上限+古ファイル削除）を実装 |
| 7 | `stdout +=` メモリ肥大化 | Buffer 配列で受け取り、concat は一度だけ |
| 8 | `residualBuffer` リーク | `VAD_FRAME_BYTES` 超過時のガードを追加 |
| 9 | `BoundedBuffer.clear()` リーク | 配列要素を null で上書きして GC を確実に促す |
| 10 | マイク切断時の再接続なし | 指数バックオフ付き自動再接続ロジックを実装 |
| 11 | `unhandledRejection` 未処理 | グローバルハンドラを追加してログ記録 |
| 12 | tmp ファイル残留 | `tmpRegistry` で exit 時に確実削除 |
| 13 | ヘルスモニタリング欠如 | `HealthMonitor`（1 分毎ログ・GC ヒント）を実装 |
| 14 | エネルギー VAD フォールバック欠如 | node-vad ロード失敗時に純 TS 実装へ自動切替 |

---

## v2.1 で追加した修正

| # | 問題 | 修正内容 |
|---|---|---|
| 15 | 60 秒超の録音でチャンクがドロップ | `MAX_SEGMENT_SECONDS` 到達で中間セグメントを emit してドロップを回避 |
| 16 | whisper.cpp 起動がメインのイベントループをブロック | `worker_threads` + Worker Pool で完全分離 |
| 17 | コマンド種別が起動スクリプトに散らかっていた | commander 化・サブコマンド `start` / `download-model` / `doctor` / `list-models` |
| 18 | モデル取得が手動 (`bash` スクリプト経由) | `npm run download-model -- <name>` で huggingface から直接取得 |
| 19 | transcriber.ts の壊れた import | `makeTmpPath` / `safeUnlink` を `./platform` から import するよう修正 |
| 20 | 起動前の依存チェックが README 任せ | `npm run doctor` で一括診断 |
