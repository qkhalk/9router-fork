# アラート

9Router は注意が必要な事象を **Telegram**・**Discord**・任意の**汎用 Webhook** に通知できます。コーディングが止まる前に気づけるようにするためです。

通知送信は fire-and-forget です。リクエスト処理をブロック・减速することは一切なく、チャネルを設定するまでシステム全体が無効のままです。

---

## クイックセットアップ

```
Dashboard → Alerts

1. チャネルを追加（Telegram / Discord / Webhook）
2. 受け取りたいイベントを選択（デフォルトは全て ON）
3. 「Test」をクリックしてテスト通知を送信
4. 完了 ✅
```

### Telegram

1. [@BotFather](https://t.me/BotFather) でボットを作成 → ボットトークンをコピー
2. ボットに任意のメッセージを送信し、チャット ID を取得（例: @userinfobot）
3. Dashboard → Alerts に **Bot Token** + **Chat ID** を貼り付け

### Discord

1. Server Settings → Integrations → Webhooks → **New Webhook**
2. Webhook URL をコピー
3. Dashboard → Alerts に貼り付け

Discord には色付き embed で届きます: 青 = info、オレンジ = warn、赤 = critical。

### 汎用 Webhook

JSON POST を受け付ける任意の URL:

```json
{
  "eventType": "quota-near-limit",
  "severity": "warn",
  "title": "クォータ残りわずか",
  "body": "Claude Code: 82% 使用済み（2時間後にリセット）",
  "timestamp": "2026-09-05T10:00:00.000Z"
}
```

---

## アラートイベント

| イベント | 重要度 | 発生条件 |
|---|---|---|
| `all-accounts-locked` | critical | プロバイダーの全アカウントがレート制限中 — リクエストを処理できない |
| `quota-near-limit` | warn | プロバイダーのクォータがしきい値を超過 |
| `budget-threshold` | warn | API キーの支出がソフトしきい値（デフォルト 80%）を超過 |
| `breaker-open` | warn | 繰り返し失敗したアカウントのサーキットブレーカーがオープン |
| `breaker-recovered` | info | オープンしていたブレーカーがプローブ成功後にクローズ |
| `proxy-pool-exhausted` | critical | プロキシプールの全エントリが利用不可 |
| `strictproxy-violation` | critical | strict-proxy モードで直接接続が必要になった — リクエストを拒否 |
| `xray-node-down` | critical | アクティブな v2go/Xray ノードがヘルスプローブに失敗 |
| `xray-rotation-failed` | critical | 次の Xray ノードへの自動ローテーションに失敗 |
| `totu-fetch-failed` | warn | TOTU auto-fetch がサブスクリプションを更新できず |

イベント種別ごとに個別に ON/OFF できます。

---

## 送信の仕組み

- **チャネルごとのキュー** — 各チャネルにペーシング付きの送信キューがあり、イベントのバーストがチャットを溢れさせたり何かをブロックしたりしません。
- **リトライ** — 送信失敗はバックオフ付きで最大 3 回再試行。上流の `429 Retry-After` ヘッダーを尊重します。
- **重複排除ウィンドウ** — 同一イベントはデフォルトで 10 分間（`alertsDedupMin`）重複排除されます。
- **認証情報のマスク** — 保存済みトークン/Webhook URL は UI 上マスク表示。空欄のまま保存すれば格納値を保持します。
- **ホットパス外** — 通知送信は非同期。Telegram が落ちていてもリクエストには影響しません。

---

## 関連

- [API キーと予算](./api-keys.md) - `budget-threshold` はキーごとの予算から発生
- [サーキットブレーカー](./circuit-breaker.md) - `breaker-open` / `breaker-recovered` の発生源
- [クォータ追跡](./quota-tracking.md) - `quota-near-limit` と Quota ダッシュボード
