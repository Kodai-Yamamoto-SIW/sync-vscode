# vsc-extension-quickstart

このドキュメントは「sync-vscode」拡張機能の開発者向けクイックスタートガイドです。

## 開発環境のセットアップ

1. リポジトリをクローン
2. 必要な依存パッケージをインストール
   ```sh
   npm install
   ```
3. TypeScriptでビルド
   ```sh
   npm run compile
   ```
4. デバッグ実行
   - VS CodeでF5キーを押して拡張機能開発ホストを起動

## 主なnpmスクリプト
- `npm run compile` : TypeScriptのビルド
- `npm run watch`   : 監視付きビルド
- `npm test`        : テスト実行

## パッケージングと配布
- vsceを使ってVSIXパッケージを作成
  ```sh
  npx vsce package
  ```
- 作成したVSIXファイルはVS Codeからインストール可能

## 注意事項
- engines.vscodeのバージョンと@types/vscodeのバージョン整合性に注意
- 機密情報（パスワード等）は公開しないこと

---
このファイルはユーザー向けではありません。
