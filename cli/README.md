# whisper-local-cli

ローカル完結のリアルタイム音声文字起こし CLI。
マイクから取り込んだ音声を [whisper.cpp](https://github.com/ggerganov/whisper.cpp) に渡し、`.wav` と `.txt` を `./outputs/` に書き出します。Windows / Linux / macOS で動作します。

主な特徴:

- **完全非同期パイプライン (worker_threads)** — 録音 → Queue → Worker → whisper.cpp を別スレッド化し、長時間録音中も UI / VAD / 録音処理が一切ブロックされない
- **長時間録音対応 (セグメント分割)** — 沈黙で切れない長い発話を `--max-segment` 秒ごとに自動分割し、オーバーラップ付きで連続文字起こし
- **並列ワーカー** — `--concurrency N` で whisper Worker を複数立ち上げて並列に文字起こし
- **24/7 常駐運用対応** — マイク自動再接続 / ログローテーション / ヘルスモニタ / 一時ファイル自動クリーンアップ

---

## アーキテクチャ

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

- **メインスレッド**: マイク受信 / VAD / セグメント分割 / Queue 管理のみを担当
- **Worker スレッド (1 個以上)**: whisper.cpp サブプロセスの起動・I/O・テキスト抽出
- **転送**: PCM Buffer を `ArrayBuffer` Transferable として渡すのでコピーコストなし
- **長時間発話**: `--max-segment` 秒 (デフォルト 30 秒) 経過したら、その時点までのチャンクを「中間セグメント」として Queue に流し、`--segment-overlap` 秒分のオーバーラップを付けて録音継続
- **並列度**: `--concurrency N` で whisper Worker を複数立ち上げて並列に文字起こし

### 長時間録音の仕組み

1. 録音中、PCM バッファの長さが `--max-segment` 秒 (デフォルト 30 秒) に達したら、その時点までを「中間セグメント (segmentIndex=0, 1, 2, …)」として Queue に流す
2. 末尾 `--segment-overlap` 秒 (デフォルト 0.3 秒) を新しいバッファの先頭に複製し、録音は中断なく継続
3. 沈黙が検出されたら最後のセグメントを「最終セグメント」として Queue に流して voice_end
4. 各セグメントは独立に Worker Pool で並列文字起こし → ファイル名は `YYYYMMDD_HHMMSS_<segmentIndex>.{wav,txt}`

これにより、講演・会議など長時間の連続発話でもメモリを圧迫せず、録音と文字起こしが時間軸でずれずにキャッチアップできます。

### ディレクトリ構成

```
whisper-local-cli/
├── src/
│   ├── bin/
│   │   └── cli.ts                 # commander エントリ
│   ├── commands/
│   │   ├── start.ts               # 常駐録音メインロジック
│   │   ├── download-model.ts      # huggingface からモデル取得
│   │   ├── doctor.ts              # 環境診断
│   │   ├── list-models.ts         # モデル一覧
│   │   └── setup-whisper.ts       # whisper.cpp の git clone & cmake ビルド
│   ├── worker/
│   │   ├── transcriber-worker.ts  # worker_thread 本体
│   │   └── transcriber-pool.ts    # Worker Pool マネージャ
│   ├── index.ts                   # 互換用エントリ (start にフォールバック)
│   ├── recorder.ts                # マイク録音 + VAD + セグメント分割
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

## クイックスタート

下のコマンドを順に実行すれば、最低限の文字起こしができる状態になります。

```bash
# 1. 依存パッケージのインストール
pnpm install                              # または npm install

# 2. TypeScript をビルド
npm run build

# 3. whisper.cpp を git clone & cmake ビルド
npm run setup-whisper

# 4. ggml モデルをダウンロード (base = 142 MB)
npm run cli -- download-model base

# 5. 環境がそろっているか診断
npm run cli -- doctor

# 6. 起動 (Ctrl+C で終了)
npm run cli -- start
```

> 👉 **`npm run cli` の引数について**
> このプロジェクトは tsx を使って TypeScript の CLI (`src/bin/cli.ts`) を直接実行します。
> `npm run cli` の後ろに `--` を付けてからサブコマンドとオプションを渡します。
>
> ```bash
> # サブコマンドだけ
> npm run cli -- doctor
>
> # オプション付き (Linux / macOS / Git Bash)
> npm run cli -- start --model ./models/ggml-small.bin --concurrency 2
> ```
>
> **Windows PowerShell で `--flag value` を渡したい場合は引数全体を引用符で囲んでください。**
> PowerShell 5.1 は `--` 以降の `--flag` を勝手に削るため、丸ごと 1 つの文字列にしないと届きません。
>
> ```powershell
> # PowerShell: 引数全体を 1 文字列に
> npm run cli -- 'start --model ./models/ggml-small.bin --concurrency 2'
> ```

---

## コマンド一覧

| コマンド | 何をするか |
|---|---|
| [`start`](#start-マイク常駐で文字起こし)               | マイクから常駐録音して文字起こし |
| [`download-model`](#download-model-モデルをダウンロード) | huggingface から ggml モデルを取得 |
| [`doctor`](#doctor-環境診断)                           | 依存ツール / バイナリ / モデルを診断 |
| [`list-models`](#list-models-モデル一覧)               | インストール済みモデルを一覧 |
| [`setup-whisper`](#setup-whisper-whispercpp-をビルド)  | whisper.cpp を git clone & cmake ビルド |

ヘルプ:

```bash
npm run cli -- help                # 全体ヘルプ
npm run cli -- help start          # start のオプション一覧
npm run cli -- start --help        # 同上
```

---

### `start` — マイク常駐で文字起こし

```bash
npm run cli -- start [options]
```

| オプション | デフォルト | 説明 |
|---|---|---|
| `-m, --model <path>`         | `./models/ggml-base.bin` | ggml モデルファイル |
| `-b, --whisper-bin <path>`   | OS 自動判定              | whisper.cpp バイナリ |
| `-l, --language <lang>`      | `ja`                     | 言語コード (`ja`, `en` など) |
| `-o, --output <dir>`         | `./outputs`              | `.wav` / `.txt` の出力先 |
| `--vad <0-3>`                | `2`                      | VAD 感度 (大きいほど厳密) |
| `--threads <n>`              | CPU コア数/2             | whisper.cpp の推論スレッド数 |
| `--queue-size <n>`           | `8`                      | セッションキューの最大件数 |
| `--concurrency <n>`          | `1`                      | whisper Worker の並列数 |
| `--device <id>`              | (自動)                   | マイクデバイス ID (例: `hw:1,0`) |
| `--max-segment <seconds>`    | `30`                     | 長時間発話の分割秒数 |
| `--segment-overlap <seconds>`| `0.3`                    | セグメント間のオーバーラップ秒数 |
| `--log-dir <dir>`            | `./logs`                 | ログ出力ディレクトリ |
| `--log-level <level>`        | `INFO`                   | `DEBUG` / `INFO` / `WARN` / `ERROR` |
| `--log-max-mb <n>`           | `10`                     | ログ 1 ファイルの最大サイズ (MB) |
| `--log-max-files <n>`        | `7`                      | 保持するログファイル数 |
| `--no-log-console`           | —                        | ログをコンソールに出さない |
| `--no-color`                 | —                        | カラー出力を無効化 |

#### よくある使い方

```bash
# とりあえず動かす (全部デフォルト)
npm run cli -- start

# small モデル + 並列度 2 で高速化
npm run cli -- start --model ./models/ggml-small.bin --concurrency 2

# 英語を文字起こし
npm run cli -- start --language en

# 出力先を変える
npm run cli -- start --output ./transcripts

# Linux で特定マイクを指定
npm run cli -- start --device hw:1,0

# デバッグログを出す
npm run cli -- start --log-level DEBUG

# 長い講演を細かく分割する (15 秒ごと)
npm run cli -- start --max-segment 15

# 24/7 運用 (ビルド済み + GC ヒント有効)
node --expose-gc dist/bin/cli.js start --concurrency 2 --log-level INFO
```

> Windows PowerShell の場合は `npm run cli -- 'start --model ./models/ggml-small.bin --concurrency 2'` のように引数を 1 文字列にまとめてください。

終了は **Ctrl+C** です。終了時に稼働時間 / 文字起こし数 / エラー数の統計が表示されます。

---

### `download-model` — モデルをダウンロード

```bash
npm run cli -- download-model [name] [options]
```

| オプション / 引数 | デフォルト | 説明 |
|---|---|---|
| `[name]`                  | —          | モデル名 (`base`, `small`, `large-v3` など) |
| `-d, --dest <dir>`        | `./models` | 保存先ディレクトリ |
| `-f, --force`             | —          | 既存ファイルを上書きする |
| `-q, --quantized <q>`     | —          | 量子化バリアント (`q5_0`, `q8_0` など) |
| `--list`                  | —          | 利用可能モデル一覧を表示 |

#### 選べるモデル

| 名前 | サイズ | 用途 |
|---|---|---|
| `tiny`             | 75 MB  | 最速・精度低 |
| `tiny.en`          | 75 MB  | 英語専用・tiny |
| `base`             | 142 MB | 標準・バランス型（推奨） |
| `base.en`          | 142 MB | 英語専用・base |
| `small`            | 466 MB | 高精度 |
| `small.en`         | 466 MB | 英語専用・small |
| `medium`           | 1.5 GB | 高精度・低速 |
| `medium.en`        | 1.5 GB | 英語専用・medium |
| `large-v1`        | 2.9 GB | 旧 large |
| `large-v2`        | 2.9 GB | 安定版 large |
| `large-v3`        | 2.9 GB | 最新 large・最高精度 |
| `large-v3-turbo`  | 1.5 GB | large-v3 の高速版 |

#### 使い方

```bash
# 利用可能なモデルを一覧表示
npm run cli -- download-model --list

# base をダウンロード (./models/ggml-base.bin に保存)
npm run cli -- download-model base

# large-v3 の量子化版 (容量が小さい)
npm run cli -- download-model large-v3 --quantized q5_0

# 保存先を変えて再ダウンロード
npm run cli -- download-model base --dest ./my-models --force
```

---

### `doctor` — 環境診断

```bash
npm run cli -- doctor [options]
```

| オプション | デフォルト | 説明 |
|---|---|---|
| `-m, --model <path>`       | `./models/ggml-base.bin` | チェックするモデルファイル |
| `-b, --whisper-bin <path>` | OS 自動判定              | チェックする whisper.cpp バイナリ |

Node.js / 音声入力ツール (sox/arecord) / whisper.cpp バイナリ / モデルファイル / 出力ディレクトリの状態を一括チェックし、不足があれば次に取るべき操作を提示します。

```bash
# デフォルト構成でチェック
npm run cli -- doctor

# 別のモデルで起動できるか確認
npm run cli -- doctor --model ./models/ggml-small.bin
```

---

### `list-models` — モデル一覧

```bash
npm run cli -- list-models [options]
```

| オプション | デフォルト | 説明 |
|---|---|---|
| `-d, --dest <dir>` | `./models` | モデルファイルが置いてあるディレクトリ |

```bash
npm run cli -- list-models
npm run cli -- list-models --dest ./my-models
```

---

### `setup-whisper` — whisper.cpp をビルド

`whisper.cpp` を git clone して cmake でビルドし、`./whisper.cpp/build/bin/...` に `whisper-cli` 実行ファイルを生成します。前提として `git` と `cmake` (Windows では加えて Visual Studio Build Tools) が PATH に通っている必要があります。

```bash
# 専用 npm script (フラグなしならどの環境でも動く)
npm run setup-whisper

# CLI 経由でフラグ付きで呼ぶ場合
npm run cli -- setup-whisper [options]
```

| オプション | デフォルト | 説明 |
|---|---|---|
| `--dir <path>`    | `./whisper.cpp` | clone 先ディレクトリ |
| `--repo <url>`    | 公式リポジトリ  | clone するリポジトリ URL |
| `--branch <name>` | (未指定)        | チェックアウトするブランチ / タグ |
| `--rebuild`       | —               | 既存の `build/` を削除してから cmake をやり直す |
| `--pull`          | —               | 既に clone 済みの場合に `git pull` で更新する |

```bash
# 最短コース (公式リポジトリを浅く clone してビルド)
npm run setup-whisper

# 指定ブランチをチェックアウト
npm run cli -- setup-whisper --branch v1.7.1

# 既にある clone を更新してから再ビルド
npm run cli -- setup-whisper --pull --rebuild

# 別の場所に置く
npm run cli -- setup-whisper --dir ./vendor/whisper.cpp
```

ビルドが終わると次のパスにバイナリが置かれます:

- Linux / macOS: `./whisper.cpp/build/bin/whisper-cli`
- Windows:       `./whisper.cpp/build/bin/Release/whisper-cli.exe`

別のパスのバイナリを使いたい場合は `start` / `doctor` の `--whisper-bin <path>` で指定します。

---

## 必要環境

### Windows 11
| ツール | 入手先 |
|---|---|
| Node.js 18+                       | https://nodejs.org |
| CMake                             | https://cmake.org/download/ |
| Visual Studio 2022 Build Tools    | https://aka.ms/vs/17/release/vs_BuildTools.exe |
| SoX (オーディオ入力)              | https://sourceforge.net/projects/sox/ (インストール後 PATH を通す) |

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

## whisper.cpp のビルド

通常は `npm run setup-whisper` で自動で git clone & cmake ビルドできます ([`setup-whisper` コマンド](#setup-whisper-whispercpp-をビルド) を参照)。

手動でビルドしたい場合:

**Linux / macOS:**
```bash
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build --config Release -j$(nproc)
cd ..
```

**Windows (PowerShell・管理者):**
```powershell
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build --config Release
cd ..
```

---

## 24/7 運用

### systemd サービス (Linux)

`/etc/systemd/system/whisper-cli.service`:

```ini
[Unit]
Description=Whisper Local Transcriber
After=network.target sound.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/whisper-local-cli
ExecStart=/usr/bin/node --expose-gc dist/bin/cli.js start \
  --language ja \
  --concurrency 2 \
  --log-level INFO
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable whisper-cli
sudo systemctl start whisper-cli
sudo journalctl -u whisper-cli -f
```

### Windows サービス (NSSM)

```powershell
nssm install WhisperCLI "C:\Program Files\nodejs\node.exe"
nssm set WhisperCLI AppParameters "--expose-gc C:\path\to\dist\bin\cli.js start --language ja --concurrency 2"
nssm set WhisperCLI AppDirectory "C:\path\to\whisper-local-cli"
nssm start WhisperCLI
```

---

## トラブルシューティング

困ったらまず:

```bash
npm run cli -- doctor
```

### `sox が見つかりません` (Windows / macOS)
- Windows: https://sourceforge.net/projects/sox/ をインストールして PATH に追加
- macOS: `brew install sox`

### `arecord: device not found` (Linux)
```bash
arecord -l                                        # デバイス一覧を表示
npm run cli -- start --device hw:1,0              # 指定して再起動
```

### `whisper.cpp バイナリが見つかりません`
`npm run setup-whisper` を実行するか、別ビルドのバイナリを `--whisper-bin <path>` で指定してください。

### モデルダウンロードが遅い / 失敗する
huggingface はリージョンによっては不安定です。

```bash
# 再試行 (上書き)
npm run cli -- download-model base --force
```

または `https://huggingface.co/ggerganov/whisper.cpp` から `ggml-*.bin` を手動で `./models/` に置いても OK。

### `node-vad` のネイティブビルドエラー
内蔵のエネルギーベース VAD に自動フォールバックするので、無視して動作確認できます。完全に直したい場合:
```bash
sudo apt install python3 build-essential   # Linux の場合
npm install --build-from-source
```

### メモリ使用量が増え続ける
GC ヒントを有効化したビルド版で起動し、長いセグメントは小さく刻む:
```bash
node --expose-gc dist/bin/cli.js start --max-segment 15 --log-level INFO
tail -f logs/whisper-cli-*.log | grep Health
```

---

## 出力ファイル

文字起こしが完了すると、各セグメントが次の形式で `./outputs/` (またはオプション `--output` で指定したディレクトリ) に保存されます。

```
outputs/
├── 20260526_142301_0.wav   # 録音された音声
├── 20260526_142301_0.txt   # 文字起こし結果
├── 20260526_142331_1.wav   # 長時間発話の 2 セグメント目
├── 20260526_142331_1.txt
└── …
```

ファイル名末尾の `_0`, `_1`, … は長時間発話を `--max-segment` 秒ごとに分割したときの連番です。

---

## 環境変数フォールバック

すべての設定値は CLI オプションで指定できますが、互換のため同名の環境変数からも読み込みます (優先度は CLI オプション > 環境変数 > デフォルト)。

| 環境変数 | 対応する CLI オプション |
|---|---|
| `WHISPER_MODEL`           | `--model` |
| `WHISPER_BIN`             | `--whisper-bin` |
| `WHISPER_LANG`            | `--language` |
| `WHISPER_THREADS`         | `--threads` |
| `OUTPUT_DIR`              | `--output` |
| `VAD_MODE`                | `--vad` |
| `QUEUE_SIZE`              | `--queue-size` |
| `WORKER_CONCURRENCY`      | `--concurrency` |
| `MIC_DEVICE`              | `--device` |
| `MAX_SEGMENT_SECONDS`     | `--max-segment` |
| `SEGMENT_OVERLAP_SECONDS` | `--segment-overlap` |
| `LOG_DIR`                 | `--log-dir` |
| `LOG_LEVEL`               | `--log-level` |
| `LOG_MAX_MB`              | `--log-max-mb` |
| `LOG_MAX_FILES`           | `--log-max-files` |
| `LOG_CONSOLE=false`       | `--no-log-console` |
| `NO_COLOR=1`              | `--no-color` |
