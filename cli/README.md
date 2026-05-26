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
├── whisper.cpp/           # whisper.cpp ソース (setup-whisper で自動 clone)
├── vendor/                # 自動 DL した cmake 等の外部ツール置き場 (setup-whisper で自動作成)
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

`whisper.cpp` を git clone して cmake でビルドし、`./whisper.cpp/build/bin/...` に `whisper-cli` 実行ファイルを生成します。あわせて **マイク入力に必要な `sox` (Windows / macOS) / `arecord` (Linux) も自動で用意** します。

**必要なもの** — このコマンドが揃えるもの / 自分で入れるもの:

| ツール | 必須 | 無いとき |
|---|---|---|
| `git`                              | ✅ あらかじめ PATH に必要 | https://git-scm.com/ からインストール |
| `cmake`                            | 🔄 **無ければ自動 DL** | `vendor/cmake/` に Kitware 公式リリースを取得して使う |
| `sox` (Windows / macOS)            | 🔄 **無ければ自動 install** | Windows は `vendor/sox/` に SourceForge から portable 版を取得 / macOS は `brew install sox` を実行 |
| `arecord` (Linux のみ)              | ⚠️ あらかじめ PATH に必要 | `sudo` が必要なので自動 install しない。`sudo apt install alsa-utils` で入れる |
| C++ コンパイラ (MSVC / clang / gcc) | ✅ あらかじめ PATH に必要 | Windows: Visual Studio 2022 Build Tools / Linux: `build-essential` / macOS: Xcode CLT |

```bash
# 専用 npm script (フラグなしならどの環境でも動く)
npm run setup-whisper

# CLI 経由でフラグ付きで呼ぶ場合
npm run cli -- setup-whisper [options]
```

| オプション | デフォルト | 説明 |
|---|---|---|
| `--dir <path>`          | `./whisper.cpp` | clone 先ディレクトリ |
| `--repo <url>`          | 公式リポジトリ  | clone するリポジトリ URL |
| `--branch <name>`       | (未指定)        | チェックアウトするブランチ / タグ |
| `--rebuild`             | —               | 既存の `build/` を削除してから cmake をやり直す |
| `--pull`                | —               | 既に clone 済みの場合に `git pull` で更新する |
| `--cmake-version <ver>` | `3.31.5`        | 自動 DL する cmake のバージョン |
| `--no-auto-cmake`       | —               | cmake が無くても自動ダウンロードしない (手動 install のみ許容) |
| `--no-auto-sox`         | —               | sox が無くても自動 install しない (Windows / macOS) |

```bash
# 最短コース (公式リポジトリを浅く clone、必要なら cmake も自動 DL してビルド)
npm run setup-whisper

# cmake は自分で入れたものを使いたい (PATH にあれば自動でそれを使う)
npm run cli -- setup-whisper --no-auto-cmake

# cmake のバージョンを指定して DL
npm run cli -- setup-whisper --cmake-version 3.30.5

# 指定ブランチをチェックアウト
npm run cli -- setup-whisper --branch v1.7.1

# 既にある clone を更新してから再ビルド
npm run cli -- setup-whisper --pull --rebuild

# 別の場所に置く
npm run cli -- setup-whisper --dir ./vendor/whisper.cpp
```

#### cmake が自動でダウンロードされる仕組み

PATH に `cmake` が見つからない場合は次の順に動きます:

1. `vendor/cmake/cmake-<ver>-<os>-<arch>/` にあるバイナリを探して再利用
2. なければ [Kitware 公式リリース](https://github.com/Kitware/CMake/releases) から OS / アーキ用の portable 版を `vendor/cmake/` に取得
3. アーカイブを展開し、その中の `cmake` を以降のビルドで使用する

ダウンロードされるファイル例:

| OS / arch        | ファイル名 | サイズ |
|---|---|---|
| Windows x64      | `cmake-3.31.5-windows-x86_64.zip`    | 約 45 MB |
| macOS (Universal)| `cmake-3.31.5-macos-universal.tar.gz` | 約 90 MB |
| Linux x64        | `cmake-3.31.5-linux-x86_64.tar.gz`    | 約 50 MB |

`vendor/` は `.gitignore` 済みです。自動 DL を完全に止めたい場合は `--no-auto-cmake` を付けてください。

#### ビルド成果物の場所

- Linux / macOS: `./whisper.cpp/build/bin/whisper-cli`
- Windows:       `./whisper.cpp/build/bin/Release/whisper-cli.exe`

別のパスのバイナリを使いたい場合は `start` / `doctor` の `--whisper-bin <path>` で指定します。

---

## SoX (音声入力ツール) について

このプロジェクトでは内部で `mic` パッケージを使ってマイクから生 PCM を読み出していますが、`mic` 自体は録音バックエンドを呼び出すだけで、実際にマイクから音を取り込むのは OS ごとに以下のツールです。

| OS | 使われるツール | 役割 |
|---|---|---|
| Windows / macOS | **SoX** (`sox` 実行ファイル) | マイクから 16kHz / mono / 16bit PCM を吸い出して標準出力に流す |
| Linux           | **arecord** (`alsa-utils` パッケージ) | 同上 (ALSA バックエンド経由) |

どちらも単体の CLI ツールで、PATH に `sox` または `arecord` があれば自動的に使われます (`mic` パッケージが内部で `spawn` する)。これらが無いと `start` 起動時に「sox が見つかりません」「arecord: device not found」エラーになります。

### `npm run setup-whisper` が代わりにやってくれること

`npm run setup-whisper` を実行すると、cmake と一緒に sox / arecord も次のように確保します。

| OS | 自動でやること |
|---|---|
| **Windows** | PATH に sox が無ければ SourceForge から `sox-14.4.2-win32.zip` (約 2.5 MB) を `vendor/sox/` にダウンロード&展開 |
| **macOS**   | PATH に sox が無ければ `brew install sox` を実行 (Homebrew が必要) |
| **Linux**   | `arecord` の有無のみチェック。無ければ手動 install 用のコマンドを表示するだけ (sudo 権限が必要なので自動実行しない) |

`vendor/sox/` 配下に置かれた sox は `start` / `doctor` 起動時に自動で PATH 先頭に追加されるので、グローバル install は不要です。

### 自分で個別にインストールしたい場合

#### Windows

```powershell
# 方法 A: setup-whisper による自動 DL を使う (推奨)
npm run setup-whisper                              # vendor/sox/sox-14.4.2/sox.exe に入る

# 方法 B: 公式サイトからインストーラを使う
# https://sourceforge.net/projects/sox/files/sox/14.4.2/sox-14.4.2-win32-installer.exe をダウンロードして実行
# その後 PATH に C:\Program Files (x86)\sox-14-4-2 を通す

# 方法 C: パッケージマネージャを使う
winget install ChrisBagwell.SoX
# または
choco install sox.portable
# または
scoop install sox

# 確認
sox --version
```

#### macOS

```bash
# 方法 A: setup-whisper から自動で brew install させる (推奨)
npm run setup-whisper                              # brew が入っていれば自動

# 方法 B: 自分で brew install
brew install sox

# 方法 C: MacPorts
sudo port install sox

# 確認
sox --version
```

#### Linux (Ubuntu / Debian)

Linux では sox ではなく **arecord** (`alsa-utils`) を使います。sudo が必要なので自動 install は行わず、自分で:

```bash
sudo apt update
sudo apt install -y alsa-utils                     # arecord を入れる

# 確認
arecord -l                                         # マイク一覧
arecord --version
```

その他のディストリ:

```bash
# Fedora / RHEL
sudo dnf install -y alsa-utils

# Arch
sudo pacman -S alsa-utils
```

### 動作確認 / トラブル切り分け

```bash
# 1. インストールできているか
npm run cli -- doctor

# 2. SoX を直接叩いて 3 秒録音 → wav 保存 (Windows / macOS)
sox -d -t wav test.wav trim 0 3

# 3. arecord で 3 秒録音 (Linux)
arecord -d 3 -f cd test.wav

# 4. デバイス一覧
sox -h                                             # ※ Windows ビルドは waveaudio デバイスを使う
arecord -l                                         # Linux: マイク番号を確認
```

Linux で複数マイクが刺さっているときは、`arecord -l` で出てきた `card 1, device 0` のような番号を `--device hw:1,0` の形で `start` に渡します。

---

## 必要環境

### Windows 11
| ツール | 必須 | 入手先 |
|---|---|---|
| Node.js 18+                       | ✅       | https://nodejs.org |
| git                               | ✅       | https://git-scm.com/ |
| Visual Studio 2022 Build Tools    | ✅       | https://aka.ms/vs/17/release/vs_BuildTools.exe |
| SoX (マイク入力)                  | (任意)   | 入っていなければ `npm run setup-whisper` が `vendor/sox/` に自動 DL |
| CMake                             | (任意)   | 入っていなければ `npm run setup-whisper` が `vendor/cmake/` に自動 DL |

### Linux (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install -y nodejs npm git build-essential libasound2-dev alsa-utils
# ↑ alsa-utils (arecord) は必須で、sudo が必要なので setup-whisper では自動 install しません

# cmake は `npm run setup-whisper` が自動 DL するので不要だが、apt の方が早ければ:
# sudo apt install -y cmake
```

### macOS
```bash
brew install node git
# sox / cmake は `npm run setup-whisper` が brew 経由 / 自動 DL してくれるので必須ではない。
# 自分で先に入れたい場合:
# brew install sox cmake
```

---

## whisper.cpp のビルド

`npm run setup-whisper` がそのまま git clone + (必要なら) cmake 自動 DL + cmake ビルドまで全部やります。詳しくは [`setup-whisper` コマンド](#setup-whisper-whispercpp-をビルド) を参照。

```bash
# これだけで OK
npm run setup-whisper
```

手動で同じことをやりたい場合は内部で実行している git / cmake コマンドを参照してください (Linux/macOS の場合 `cmake -B build -DWHISPER_BUILD_EXAMPLES=ON && cmake --build build --config Release -j$(nproc)`、Windows は `--config Release` 付きで MSVC 経由)。

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

`npm run setup-whisper` を実行すれば自動で sox が用意されます。

- Windows: `vendor/sox/sox-14.4.2/sox.exe` に SourceForge から portable 版を自動 DL
- macOS: `brew install sox` を自動実行 (Homebrew が無ければエラー → 先に brew を入れる)

手動で入れたい場合は[「SoX について」](#sox-音声入力ツール-について) を参照してください。自動 DL を止めるには `npm run cli -- setup-whisper --no-auto-sox` を使います。

### `arecord: device not found` (Linux)

Linux では `alsa-utils` (sudo 必要) を自分で入れる必要があります:

```bash
sudo apt install -y alsa-utils
arecord -l                                        # マイク一覧を表示 (card N, device M を確認)
npm run cli -- start --device hw:1,0              # 番号を指定して起動
```

### `whisper.cpp バイナリが見つかりません`
`npm run setup-whisper` を実行するか、別ビルドのバイナリを `--whisper-bin <path>` で指定してください。

### `cmake が見つかりません` / 自動 DL に失敗する
通常は `npm run setup-whisper` 内で cmake が自動 DL されますが、ファイアウォール等で `github.com` への HTTPS が通らない環境では失敗します。

```bash
# 自動 DL を無効化して、自分でインストールした cmake を使う
npm run cli -- setup-whisper --no-auto-cmake

# 別バージョンを試す
npm run cli -- setup-whisper --cmake-version 3.30.5
```

すでに自動 DL したアーカイブが残っていれば `vendor/cmake/*.zip` (または `.tar.gz`) を再利用するので、ネットが不安定でも再実行で進められます。

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
