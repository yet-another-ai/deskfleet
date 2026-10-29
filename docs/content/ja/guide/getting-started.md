# DeskFleet を実行する

配布版は [GitHub Releases](https://github.com/yet-another-ai/deskfleet/releases) から入手できます。現在の開発版を試すには、以下の手順でソースコードから実行してください。

## 開発環境をセットアップする

Git、[mise](https://mise.jdx.dev/)、Docker Compose を含む Docker をインストールします。Docker を起動し、ログインシェルで次のコマンドを実行してください。Windows では PowerShell 7（`pwsh`）を使用します。

```sh
git clone https://github.com/yet-another-ai/deskfleet.git
cd deskfleet
mise trust
mise install --locked
mise run install
mise run infra:up
mise -E development run dev
```

ローカルのインフラには、PostgreSQL、Redis、TURN が含まれます。`dev` は API と Web クライアントを一緒に起動します。Web クライアントを使うには、`http://localhost:5174/` を開いてください。パスキーには DNS ホスト名が必要なため、Web と API のアドレスには一貫して `localhost` を使用します。

デスクトップアプリを使う場合は、別のターミナルで起動します。

```sh
mise run desktop:dev
```

デスクトップアプリのブラウザーログインにも Web サービスを使用するため、`dev` は起動したままにしてください。

## アカウントを作成する

DeskFleet 自体がアカウント登録とログインを管理します。ログイン画面で **アカウントを作成** を選び、メールアドレスを入力してください。リポジトリの `.local/mail/` に保存された確認メールのリンクを開き、表示名とパスワードを設定します。ローカル開発環境では、メールは外部に送信されません。

すぐに試せるサイト管理者アカウントを作成したい場合は、別のターミナルで次のコマンドを実行できます。

```sh
mise run dev:seed
```

この任意のコマンドは、ローカルの開発用データベースに確認済みアカウントを作成します。メールアドレス `admin@deskfleet.test`、パスワード `deskfleet-dev-password` で、そのままログインできます。通常の登録では、サイト管理者権限やチームへの所属は付与されません。

## 最初のマシンを追加する

ログインしてチームを作成し、**マシンを追加** を選択します。デスクトップアプリでは **このコンピューター** を選択すると、内蔵デーモンが登録されます。そのコンピューターにエージェントの CLI をインストールして認証し、**設定 → エージェント** で構成してください。

既存のディレクトリを指定してワークスペースを作成します。セッションを開始し、エージェントを選んでタスクを入力してください。独立した Git チェックアウトを使う場合は **新しいワークツリー**、指定したディレクトリで直接作業する場合は **作業ディレクトリ** を選択します。

## ヘッドレスマシンを追加する

対象のマシンで、単独実行用のデーモンをビルドして起動します。

```sh
mise run daemon:pack
./apps/daemon/dist/deskfleet-daemon
```

Windows では PowerShell 7 を使い、`.\apps\daemon\dist\deskfleet-daemon.exe` を実行します。デーモンの `status` コマンドでマシンの識別情報を取得し、**マシンを追加** に貼り付けます。その後、表示される登録手順に従って、発行された認証情報を取り込んでください。

対応するビルド対象は、macOS Apple Silicon、Windows x64、Linux x64/arm64 です。コマンドの詳細は、リポジトリの[デーモンガイド](https://github.com/yet-another-ai/deskfleet/blob/main/apps/daemon/README.md)をご覧ください。

## リモート操作で介入する

リモートデスクトップ操作は、初回リリースの主要機能として開発中です。ホームページでは、現在のリモートデスクトップ画面を実際に動かし、録画した製品画面をサンプルストリームとして使用しています。接続、切断、全画面表示を試せます。インストールしたバージョンで利用できる操作や対応プラットフォームは、そのバージョンのリリースノートをご確認ください。
