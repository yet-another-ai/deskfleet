# DeskFleet を実行する

DeskFleet は、ネイティブデスクトップアプリ（メインプロセス内でローカルマシンデーモンをホスト）として実行できるほか、インストール可能な Web PWA からのアクセスや、ヘッドレスサーバーへの単一実行ファイル `deskfleet-daemon` の配置にも対応しています。

## デスクトップアプリをインストールする

### macOS

[GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases) からお使いの Mac に対応するディスクイメージをダウンロードします。Apple Silicon 搭載 Mac では `-mac-arm64.dmg`、Intel 搭載 Mac では `-mac-x64.dmg` で終わるファイルを選びます。ディスクイメージを開き、DeskFleet を「アプリケーション」フォルダーにドラッグします。

Apple Silicon および Intel 搭載 Mac では、公式の Homebrew Tap からもインストールできます。

```sh
brew install --cask yet-another-ai/tap/deskfleet
```

Intel 向けデスクトップ Cask は、コンパニオン Tap のパッケージング変更（[`yet-another-ai/homebrew-tap#8`](https://github.com/yet-another-ai/homebrew-tap/pull/8)）のマージ後に利用できます。それまでは Intel での Homebrew インストールに依存しないでください。公開済み Tap の Apple Silicon 向け Cask は引き続き利用できます。

- **Nix（nix-darwin、Apple Silicon および Intel）**: リリース版 flake を入力に追加し、`deskfleet` overlay を適用して `environment.systemPackages` に `pkgs.deskfleet` を追加します。nix-darwin が署名済みのアプリバンドルを `/Applications/Nix Apps` に配置し、更新を管理します。詳細は [Nix 配布ガイド](https://github.com/yet-another-ai/deskfleet/blob/main/agents/docs/ci.md#nix-distribution) を参照してください。

### Windows（`x64`）

[GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases) から `.exe` インストーラーをダウンロードして実行してください。

### Linux（`x86_64` / `ARM64`）

- **Arch Linux（AUR）**：
  ```sh
  yay -S deskfleet-bin
  ```
- **Nix（flakes 有効時）**：`<VERSION>` を先頭の `v` を除いたリリースバージョンに置き換えて実行します。
  ```sh
  nix profile add 'https://github.com/yet-another-ai/deskfleet/releases/download/v<VERSION>/deskfleet-nix.tar.gz'
  ```
  プロファイルに追加せず一時的に試す場合は、同じ URL で `nix run` を使用してください。Nix パッケージはビルド済みデスクトップアプリをインストールし、公式の DeskFleet サービスに接続します。
- **Debian / Ubuntu と Fedora / RHEL**：[GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases) から対象アーキテクチャの `.deb`（`amd64` または `arm64`）または `.rpm`（`x86_64` または `aarch64`）をダウンロードし、そのファイルをインストールしてください。次の例では `<VERSION>` とアーキテクチャを、ダウンロードしたリリースに合わせて置き換えます：
  ```sh
  sudo apt install ./deskfleet-<VERSION>-linux-amd64.deb
  sudo dnf install ./deskfleet-<VERSION>-linux-x86_64.rpm
  ```
  更新はシステムのパッケージマネージャーが管理し、これらのインストールでは AppImage の自動更新は使用されません。
- **AppImage / アーカイブ**：[GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases) から対象アーキテクチャ（`x86_64` または `arm64`）の `.AppImage` または `.tar.gz` をダウンロードしてください。

> [!NOTE]
> Linux の Wayland セッションでリモートデスクトップ共有を利用するには、デスクトップセッションの XDG Desktop Portal・PipeWire サービスおよび対応する GPU ドライバーが必要です。

## 最初のマシンを登録する

1. DeskFleet を起動してサインインし、**チーム（Team）**を作成または選択します。
2. デスクトップアプリで **マシンを追加（Add machine）** から **このコンピューター（This computer）** を選ぶと、内蔵デーモンがチームに登録されます。
3. そのマシンの **設定 → エージェント（Settings → Agents）** を開き、使用するエージェント CLI（Claude Code、Codex CLI、Cursor CLI、Grok CLI など）のインストール、確認、ログインを行います。

デスクトップウィンドウを閉じても DeskFleet はシステムトレイに常駐し、実行中のエージェントセッション、PTY ターミナル、スケジュールタスクはそのまま継続します。内蔵デーモンを停止したいときは、トレイメニューからアプリを終了してください。

## ワークスペースを作成してセッションを始める

1. 登録したマシンを選び、そのコンピューター上の 1 つ以上の既存ディレクトリを指定して**ワークスペース（Workspace）**を作成します。最初のディレクトリがデフォルトの作業ディレクトリになります。
2. 新しい**セッション（Session）**を開始し、エージェントプロバイダーを選んでタスクを入力します。
3. 作業場所のモードを選択します：
   - **新しいワークツリー（New worktree）**：コミット済みの `HEAD` から独立した Git チェックアウトを作成し、複数のセッションを競合なく並行実行します。
   - **作業ディレクトリ（Working directory）**：未コミットの変更も含めて、指定したディレクトリ内で直接作業します。

## ヘッドレスマシンを追加する

デスクトップ環境のないリモートワークステーション、VM、ビルドサーバーでは、単一実行ファイルの `deskfleet-daemon`（Windows では `deskfleet-daemon.exe`、PowerShell 7 `pwsh` を使用）を実行します。

1. [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases) から対象プラットフォーム向けのヘッドレスデーモンアーカイブをダウンロードします。
   Apple Silicon Mac では `deskfleet-macos-arm64.tar.gz`、Intel Mac では `deskfleet-macos-x64.tar.gz` を使用します。
   コンパニオン Tap のパッケージング変更（[`yet-another-ai/homebrew-tap#8`](https://github.com/yet-another-ai/homebrew-tap/pull/8)）のマージ後は、Apple Silicon / Intel Mac で `brew install yet-another-ai/tap/deskfleet-daemon` も利用できます（デーモンのみ。`brew services start` の前に登録を完了してください）。
   Linux 向けには `deskfleet-linux-x64.tar.gz` と `deskfleet-linux-arm64.tar.gz`、Windows 向けには `deskfleet-windows-x64.tar.gz` があります。
   以下のコマンドでソースコードからパッケージ化することもできます。
   ```sh
   mise run daemon:pack
   ```
   ソースからビルドした場合、実行ファイルは `./apps/daemon/dist/deskfleet-daemon`（Windows では `.\apps\daemon\dist\deskfleet-daemon.exe`）に出力されます。
2. 対象のマシンで、接続先バックエンドとチーム向けの登録バンドルを生成します：
   ```sh
   ./deskfleet-daemon prepare-enrollment --server-url https://your-backend.example --team-id <TEAM_ID>
   ```
3. デスクトップアプリまたは Web クライアントで **マシンを追加 → 別のマシン（Add machine → Another machine）** を開き、出力された登録バンドルを貼り付けます。マシンがチームに登録され、実行用の認証情報が一度だけ表示されます。
4. 発行された認証情報を標準入力からヘッドレスマシンに取り込みます：
   ```sh
   ./deskfleet-daemon enroll --server-url https://your-backend.example < machine-credentials.json
   ```
5. 登録済みのチーム状態は、秘密情報を露出せずに `./deskfleet-daemon status` でいつでも確認できます。コマンドや保存先の詳細はリポジトリの[デーモンガイド](https://github.com/yet-another-ai/deskfleet/blob/main/apps/daemon/README.md)、Android 端末での構築手順は [Android で実行する（Termux）](./android) をご覧ください。

### ホスト設定を構成する

ヘッドレスマシン（Termux 上の Android 端末を含む）では、`./deskfleet-daemon settings` を使って `$DESKFLEET_DAEMON_DIRECTORY`（初期値 `~/.deskfleet`）内のホスト設定を管理できます。変更はホスト上の全チームに再起動なしで即時反映されます：

```sh
./deskfleet-daemon settings                                      # すべての設定を表示
./deskfleet-daemon settings set remoteAgents.allowOperate true   # リモート MCP 操作を許可
./deskfleet-daemon settings set remoteAgents.allowSuperAgent true
./deskfleet-daemon settings set worktrees.root /path/to/worktrees
./deskfleet-daemon settings reset worktrees.root                 # キーまたはセクションをリセット
```

- **リモートエージェント権限**（`true` \| `false`、すべて初期値 `false`）：`remoteAgents.allowRead`、`remoteAgents.allowOperate`、`remoteAgents.allowSessions`、`remoteAgents.allowWorkspaces`、`remoteAgents.allowSuperAgent`、`remoteAgents.allowLocalCrossWorkspace`。
- **ワークツリー設定**：`worktrees.root`、`worktrees.branchNaming`（`semantic` \| `session`）、`worktrees.cleanup.<archived|merged|inactive|settled|unchanged>`、`worktrees.cleanup.inactiveDays`（`1`–`3650`）、`worktrees.cleanup.settledDays`（`0`–`3650`）、`worktrees.cleanup.keepLocalChanges`（`uncommitted` \| `all` \| `none`）。詳細は `./deskfleet-daemon settings --help` を参照してください。

## ソースコードから実行する（ローカル開発環境）

クライアント、デーモン、中央サーバー一式をローカルでソースから動かすには、Git、[mise](https://mise.jdx.dev/)、Docker Compose を含む Docker をインストールします。Docker を起動した状態で、ログインシェル（Windows では PowerShell 7 `pwsh`）から次を実行してください：

```sh
git clone https://github.com/yet-another-ai/deskfleet.git
cd deskfleet
mise trust
mise install --locked
mise run install
mise run infra:up
mise run dev:seed
mise -E development run dev
```

- **ローカルインフラ（`infra:up`）**：Docker Compose でローカルの PostgreSQL、Valkey、coturn TURN サービスを起動します。
- **開発用サイト管理者の作成（`dev:seed`）**：開発用データベースに確認済みのサイト管理者アカウント（メールアドレス `admin@deskfleet.test`、パスワード `deskfleet-dev-password`）を作成します。ログイン画面から新規登録し、`.local/mail/` に保存される確認メールのリンクから認証することも可能です。
- **API と Web クライアント（`dev`）**：`http://localhost:8080` で Actix Web バックエンドを、`http://localhost:5174/` で Web クライアントを起動します。
- **デスクトップクライアント（`desktop:dev`）**：デスクトップアプリのブラウザーログインにもローカル Web サービスを使用するため、`dev` を起動したまま別のターミナルで `mise run desktop:dev` を実行します。
