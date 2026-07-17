# Cloudflare TURN（NAT越え中継）の恒久運用

現在は Cloudflare の公開 speed-test 用 TURN を GitHub Actions
（.github/workflows/net-refresh.yml）が3時間ごとに取得して配信しています。
これは非公式利用のため、恒久運用には **Cloudflare Calls TURN**（無料枠 月1TB）を推奨:

1. Cloudflare ダッシュボード → Calls → TURN App を作成し、Key ID と API Token を取得
2. GitHub リポジトリの Settings → Secrets and variables → Actions に
   `CF_TURN_KEY_ID` と `CF_TURN_API_TOKEN` を登録
3. 以後、net-refresh ワークフローが自動的に正式APIへ切り替わります（コード変更不要）

---

# Cloudflare Worker 収集エンドポイント（大規模アクセス用）

対局データ収集を Cloudflare のエッジで受ける構成です。無料枠でも
1日10万リクエスト・R2 保存10GB・転送無料と、研究用途には十分な耐性があります。

## セットアップ手順（あなたの作業・10分程度）

1. https://dash.cloudflare.com でアカウントを作成（無料）
2. `npm install -g wrangler` → `wrangler login`
3. R2 バケットを作成:
   ```
   wrangler r2 bucket create lexio-games
   ```
4. このディレクトリでデプロイ:
   ```
   cd tools/cloudflare
   wrangler deploy
   ```
   出力される URL（例: `https://lexio-collect.<yourname>.workers.dev`）を控える。
5. リポジトリの `model/collect.json` を編集して push:
   ```json
   { "enabled": true, "httpUrl": "https://lexio-collect.<yourname>.workers.dev/games", "p2pId": "lexio-webapp-collect-1" }
   ```
   → 全クライアントが自動で HTTP 送信に切り替わります（失敗時は P2P にフォールバック）。

## データの取り出し

- ダッシュボードの R2 → lexio-games → `games/YYYY-MM-DD/` 配下に1バッチ=1ファイルで保存されます。
- 一括取得は `wrangler r2 object get` か、S3 互換 API（アクセスキーを発行）で。
- 学習への取り込みは、取得した JSON を結合して牌譜コーパスとして利用してください。

## 実装メモ

- ペイロードは gzip 圧縮（`Content-Encoding: gzip`）・512KB上限・1バッチ50局まで。
- CORS は `*`（匿名データのみのため）。必要なら Pages のオリジンに絞ってください。
- さらに堅くする場合: Turnstile トークン検証、Durable Object でのレート制限、
  R2 ライフサイクルルールで古いデータの自動削除など。
