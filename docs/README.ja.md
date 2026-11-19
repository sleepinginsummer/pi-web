# Pi Web

[English](../README.md) | [简体中文](./README.zh-CN.md) | [Русский](./README.ru.md)

[pi コーディングエージェント](https://github.com/badlogic/pi-mono) のローカル Web UI です。Pi Web はローカルの pi セッションファイルを読み込み、セッションの閲覧、リアルタイムチャット、モデル設定、スキル管理、プロジェクトファイルのプレビューを行えるブラウザワークスペースを提供します。

![Pi Web では、CLI と同じ pi セッションを、構造化された Markdown、ツール呼び出し、プロジェクトナビゲーションとともに表示できます](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

![構造化された Markdown、ツール呼び出し、プロジェクトナビゲーションとともに pi セッションを表示する Pi Web](https://raw.githubusercontent.com/agegr/pi-web/main/docs/screenshot2.png)

## 機能

- **セッションワークスペース**：プロジェクトごとに会話を閲覧、再開、名前変更、エクスポート、削除し、実行状態、コンテキスト使用量、コスト、コンパクション情報を確認できます。
- **2 種類の分岐**：**New session** は以前のメッセージから独立したセッションファイルを作成し、**Edit from here** は現在のセッション内にブランチを作成します。
- **プロジェクトファイルツール**：ファイルの閲覧とアップロード、Git Diff の確認、ソース、Markdown、画像、音声、PDF、DOCX のプレビューに対応し、変更時は自動更新されます。
- **Git worktree**：同じリポジトリのセッションをまとめたまま、サイドバーからチェックアウトを切り替えられます。
- **Web での設定**：Pi Web を離れずに、Provider のログインと API Key、モデル、モデルテスト、プラグインパッケージ、スキルを管理できます。
- **英語、簡体字中国語、繁体字中国語の UI**：初回はブラウザーの言語に従い、設定 → 一般 → 言語から切り替えられます。

## クイックスタート

Pi Web には Node.js 22.19.0 以降が必要です。現在のバージョンは `node --version` で確認できます。

**インストールせずに実行：**

```bash
npx @agegr/pi-web@latest
```

**またはグローバルにインストール：**

```bash
npm install -g @agegr/pi-web
pi-web
```

続いて [http://127.0.0.1:30141](http://127.0.0.1:30141) を開きます。サーバーの準備が整うと、CLI はブラウザを自動的に開こうとします。Pi Web はデフォルトで `127.0.0.1` のみをリッスンします。

**オプション：**

```bash
pi-web --port 8080              # カスタムポート
pi-web --hostname 0.0.0.0       # 信頼できるネットワークに公開
pi-web -p 8080 -H 0.0.0.0       # オプションを組み合わせる
pi-web --no-open                # ブラウザを自動的に開かない

PORT=8080 pi-web                # 環境変数にも対応
PI_WEB_HOSTNAME=0.0.0.0 pi-web  # ネットワーク公開を明示的に有効化
PI_WEB_ALLOWED_HOSTS=pi-web.internal pi-web  # プロキシまたはカスタムホスト名を許可
PI_WEB_PASSWORD='十分に長いランダムなパスワード' pi-web  # ログインページを有効化（ユーザー名: pi）
PI_WEB_NO_OPEN=1 pi-web         # バックグラウンドサービスとして実行する場合に便利
```

`PI_WEB_PASSWORD` を設定すると、ログインページが Web インターフェースとすべての API エンドポイントを保護します。ユーザー名は常に `pi` です。未設定または空の場合、認証は無効です。ログイン後は `HttpOnly` セッション Cookie を使用し、「30日間ログイン状態を保持」を選択した場合は永続化されます。署名用の秘密鍵は、現在のユーザーだけが読める `~/.pi/agent/pi-web-session.json` に保存されます。ネットワークを切り替える場合も、Cookie はホストごとに分離されるため、同じホスト名を使用してください。

Pi Web は高権限のエージェントを呼び出せます。インターネットへ直接公開せず、リモートアクセスには信頼できるリバースプロキシの HTTPS または信頼できる VPN を使用してください。
API リクエストでは、loopback 名、IP リテラル、選択したバインドホスト名、および `PI_WEB_ALLOWED_HOSTS` にカンマ区切りで指定した完全一致のホスト名のみを受け入れます。信頼できるリバースプロキシが異なる外部ホスト名を使用する場合は、この変数を設定してください。

## HTTP プロキシ

| オプションまたは環境変数 | 用途 | デフォルト |
| --- | --- | --- |
| `--help`、`-h` | 起動オプションを表示して終了 | — |
| `--port <port>`、`-p <port>`、または `PORT` | サーバーポート | `30141` |
| `--hostname <host>`、`-H <host>`、または `PI_WEB_HOSTNAME` | バインドするホスト名 | `127.0.0.1` |
| `--no-open` または `PI_WEB_NO_OPEN=1` | ブラウザーを自動的に開かない | 自動的に開く |
| `PI_WEB_APP_NAME` | PWA マニフェストの `name` と `short_name`。前後の空白は取り除かれ、空の値はデフォルトを使用 | `Pi Web` |
| `PI_WEB_SKIP_VERSION_CHECK=1` | Pi Web の更新チェックを無効化 | 未設定 |
| `PI_WEB_ALLOWED_HOSTS` | 追加で許可するプロキシまたはカスタムホスト名。複数指定はカンマ区切りで完全一致 | 未設定 |
| `PI_WEB_PASSWORD` | ブラウザーのパスワードログインを有効化。API はユーザー名 `pi` の Basic Auth も利用可能 | 認証なし |
| `PI_WEB_IDLE_TIMEOUT_MS` | セッションのアイドルタイムアウト（ミリ秒、最大 `2147483647`）。`0` でアイドル時の終了を無効化。無効または範囲外の値はデフォルトを使用 | `600000`（10 分） |
| `PI_WEB_SHUTDOWN_DEADLINE_MS` | セッションを閉じるとき、拡張機能が `session_shutdown` を処理するまでの猶予（ミリ秒、最大 `2147483647`）。過ぎるとセッションはそのまま破棄される。`0`、無効または範囲外の値はデフォルトを使用 | `5000`（5 秒） |
| `PI_CODEMODE_MAX_WORKERS` | 同時に実行できる codemode スクリプト数に対する pi の上限。サーバー内のすべてのセッションとサブエージェントで共有。pi 自体のデフォルトは `2` で、未設定または空の場合 pi-web は `8` を設定。各スクリプトは最大 256 MB を使用可能 | `8` |

`PI_WEB_APP_NAME` はサーバーを起動する前に設定してください（例：`PI_WEB_APP_NAME='Work Pi' pi-web`）。変更後にサーバーを再起動すると新しいマニフェストが配信され、再ビルドは不要です。インストール済み PWA の名前の更新はブラウザーが管理するため、すぐに反映されるとは限りません。ページタイトルやアイコンは変わりません。

例：

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### リモートアクセス

ループバック以外のアドレスにバインドすると、高い権限の操作を実行できるエージェントがネットワークに公開されます。信頼できる LAN で使用する場合も、十分に長いランダムなパスワードを設定してください：

```bash
PI_WEB_PASSWORD='十分に長いランダムなパスワード' pi-web --hostname 0.0.0.0
```

パスワード認証は接続を暗号化しません。平文 HTTP で Pi Web をインターネットに公開せず、信頼できるリバースプロキシによる HTTPS または信頼できる VPN を使用してください。リバースプロキシが外部ホスト名を転送する場合は、その名前を完全一致で `PI_WEB_ALLOWED_HOSTS` に追加します。この許可リストは Pi Web のバインド先を変更しません。

多数のチャット、ターミナル、ファイルプレビューを同時に使うと、平文 HTTP ではブラウザーの接続が 6 本までに制限され、リクエストが待たされます。[Serving Pi Web over HTTP/2](./http2.md) を参照してください。

### Docker

リリースごとに `ghcr.io/agegr/pi-web` へイメージを公開しています。イメージ、Compose の例、保持すべきボリュームについては [Running Pi Web in Docker](./docker.md) を参照してください。

### HTTP プロキシ

サーバー側のモデルリクエストと API リクエストは、標準の `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 環境変数を使用します。

macOS または Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## 機能

- **作業をすぐに再開**：セッションのパスやターミナル履歴を探さずに、プロジェクトごとに過去の pi の会話を閲覧できます。
- **別の方向性を安全に試す**：以前のメッセージから続けるか、セッションをフォークして別の進め方を試せます。
- **ブランチをまたいで作業**：サイドバーから Git worktree を切り替えると、新しいセッションと Explorer が選択したチェックアウトに追従します。
- **プロジェクトを見ながらチャット**：エージェントの作業中に、左側でファイルを閲覧し、右側でソース、ドキュメント、画像、音声、PDF をプレビューできます。
- **セッションの状態を明確に把握**：コンテキスト使用量、コスト、コンパクション状態、システムプロンプトの詳細をトップバーで確認できます。
- **ターミナルでの設定を削減**：モデル、ログイン／API キー、モデルテスト、スキルの切り替えを Web UI から管理できます。

## 注意事項

- **エージェントデータ**：Pi Web はデフォルトで `~/.pi/agent` の pi データを読み込みます。セッションファイルは `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl` にあります。別の pi エージェントディレクトリを使用するには `PI_CODING_AGENT_DIR` を設定してください。
- **ファイルシステムへのアクセス**：Pi Web はエージェントデータディレクトリと、セッションに記録された作業ディレクトリを読み取れる必要があります。既存の pi セッションを共有する場合は、pi と同じファイルシステム環境で Pi Web を実行してください。
- **共有設定**：Models パネルは pi のモデル、設定、認証情報ストレージを使用するため、変更は両方のインターフェースに反映されます。開いているセッションでは、保存したモデルの変更はそのモデルを選び直したときに適用されます。
- **ファイルアクセスの範囲**：ファイルブラウザーは、Pi Web で選択した作業ディレクトリと、既知のプロジェクトまたはセッションルートに限定されます。汎用のファイルシステムブラウザーではありません。
- **Git worktree**：スイッチャーの表示条件、worktree の作成、削除時の動作については [Worktrees in Pi Web](./worktrees.md) を参照してください。
- **連携フック**：Pi Web を組み込むアプリはセッション行のコンテキストメニューを置き換えられ、サーバー側の pi 拡張機能はセッションのアイドル終了を防げます。[Integration Hooks](./integrations.md) を参照してください。

## 開発

```bash
npm install
npm run dev
```

ローカル開発サーバーは [http://127.0.0.1:30141](http://127.0.0.1:30141) で動作します。

よく使うチェック：

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

ローカル開発中は `next build` / `npm run build` を実行しないでください。`.next/` に書き込みが行われ、開発サーバーに影響する可能性があります。ビルドはリリース作業に任せてください。

新機能に取りかかる前に、[Contributing](../CONTRIBUTING.md) で対象範囲とプルリクエスト前のチェック項目を確認してください。

コントリビューター向けガイド：[Internationalization](./i18n.md) と [Release process](./release.md)。

## リポジトリ構成

```text
app/
  api/
    agent/          # AgentSession を作成・操作し、SSE イベントを公開
    auth/           # OAuth と API キーの管理
    cwd/validate/   # カスタム作業ディレクトリの検証
    default-cwd/    # pi のデフォルト作業ディレクトリを取得
    files/          # ファイルの一覧、読み込み、プレビュー、監視
    home/           # 現在のユーザーのホームディレクトリ
    models/         # 利用可能なモデル、デフォルトモデル、思考レベル
    models-config/  # models.json の読み書きとモデルのテスト
    sessions/       # セッションの読み込み、名前変更、削除、コンテキスト、HTML エクスポート
    skills/         # スキルの一覧、検索、インストール、有効化／無効化
components/
  AppShell.tsx        # メインレイアウト、URL 状態、上部パネル、ファイルタブ
  SessionSidebar.tsx  # プロジェクト選択、セッションツリー、Explorer
  ChatWindow.tsx      # メッセージ、SSE、画像のドラッグ＆ドロップ、ミニマップ
  ChatInput.tsx       # 入力欄、モデル／ツール／思考／コンパクション／スラッシュコントロール
  MessageView.tsx     # メッセージ、思考、ツール呼び出し／結果の表示
  ModelsConfig.tsx    # モデルと認証の設定パネル
  SkillsConfig.tsx    # スキル管理パネル
  FileExplorer.tsx    # ファイルツリー
  FileViewer.tsx      # ソース、差分、画像、音声、PDF、DOCX のプレビュー
lib/
  http-dispatcher.ts  # サーバー側 fetch の HTTP(S) プロキシ設定
  rpc-manager.ts      # AgentSessionWrapper のライフサイクルとグローバルレジストリ
  session-reader.ts   # .jsonl セッションファイルとブランチコンテキストの解析
  normalize.ts        # toolCall フィールド名の正規化
  file-access.ts      # ファイル読み込みの安全境界
  file-paths.ts       # ファイルパスのエンコードと相対パスのヘルパー
  markdown.ts         # Markdown／Mermaid／KaTeX プラグインの設定
  pi-types.ts         # pi 関連の型
hooks/
  useAgentSession.ts  # セッションの読み込み、コマンド送信、SSE ステートマシン
  useAudio.ts         # 完了通知音
  useDragDrop.ts      # 画像のドラッグ＆ドロップ
  useTheme.ts         # テーマの切り替え
bin/
  pi-web.js           # npm CLI エントリポイント
instrumentation.ts    # サーバー HTTP ディスパッチャーの初期化
```

アーキテクチャの説明、API ルート、トピックノートについては [AGENTS.md](../AGENTS.md) を参照してください。

## ライセンス

[MIT](../LICENSE)
