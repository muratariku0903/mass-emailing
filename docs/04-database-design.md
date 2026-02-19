# データベース設計

## 使用DB

RDS（MySQL または PostgreSQL）

---

## テーブル定義

### notification_campaigns（お知らせ通知マスター）

| カラム名 | 型 | 説明 |
|---|---|---|
| id | BIGINT (PK) | キャンペーンID |
| title | VARCHAR(255) | キャンペーン名 |
| subject | VARCHAR(255) | メール件名 |
| body_html | TEXT | メール本文(HTML) |
| body_text | TEXT | メール本文(テキスト) |
| from_address | VARCHAR(255) | 送信元アドレス |
| csv_s3_key | VARCHAR(512) | CSVファイルのS3キー |
| scheduled_at | TIMESTAMP | 送信予定日時 |
| execution_arn | VARCHAR(512) | Step Functions（送信WF）実行ARN（停止・再起動用） |
| status | VARCHAR(20) | キャンペーンステータス（下記参照） |
| total_count | INT | 総宛先数 |
| sent_count | INT | 送信成功数 |
| failed_count | INT | 送信失敗数 |
| created_at | TIMESTAMP | 作成日時 |
| updated_at | TIMESTAMP | 更新日時 |

**キャンペーンステータス値:**

| DB格納値 | 意味 |
|---|---|
| 取込中 | CSV取込処理中 |
| 取込失敗 | CSV取込処理でエラー発生 |
| 送信予約済 | 送信ワークフロー待機中（指定日時まで Wait） |
| 送信中 | メール送信処理中 |
| 送信完了 | 全件送信完了 |
| 送信失敗 | 送信処理でエラー発生 |

---

### notification_recipients（宛先管理）

| カラム名 | 型 | 説明 |
|---|---|---|
| id | BIGINT (PK) | レコードID |
| campaign_id | BIGINT (FK) | キャンペーンID |
| email_address | VARCHAR(255) | 宛先メールアドレス |
| ses_message_id | VARCHAR(255) | SES送信時のMessageId（イベント紐付け用） |
| status | VARCHAR(20) | 宛先ステータス（下記参照） |
| sent_at | TIMESTAMP | 送信日時 |
| error_message | TEXT | エラーメッセージ |
| bounce_type | VARCHAR(20) | Permanent / Transient / Undetermined |
| bounce_sub_type | VARCHAR(50) | General / NoEmail / Suppressed 等 |
| diagnostic_code | TEXT | SMTP診断コード（バウンス原因調査用） |
| bounce_at | TIMESTAMP | バウンス発生日時 |
| complaint_type | VARCHAR(50) | abuse / auth-failure / fraud 等 |
| complaint_at | TIMESTAMP | 苦情発生日時 |
| created_at | TIMESTAMP | 作成日時 |
| updated_at | TIMESTAMP | 更新日時 |

**宛先ステータス値:**

| DB格納値 | 意味 |
|---|---|
| 未送信 | 登録済み、未処理 |
| 送信中 | SES呼び出し前にマーク（重複送信防止用） |
| 送信済 | SESで送信完了 |
| 送信失敗 | 送信処理でエラー発生 |
| バウンス | 送信後にバウンスが発生（Hard/Soft問わず） |
| 苦情 | 受信者がスパム報告 |

---

## インデックス

```sql
-- 宛先テーブル
CREATE INDEX idx_recipients_campaign_status
  ON notification_recipients (campaign_id, status);

CREATE INDEX idx_recipients_campaign_id
  ON notification_recipients (campaign_id, id);

-- SESイベント紐付け用（バッチLambdaからの逆引き）
CREATE INDEX idx_recipients_ses_message_id
  ON notification_recipients (ses_message_id);

-- ソフトバウンス累計カウント用（メールアドレス単位のキャンペーン横断集計）
CREATE INDEX idx_recipients_email_status
  ON notification_recipients (email_address, status);

-- 抑制リストテーブル
CREATE UNIQUE INDEX idx_suppression_email
  ON suppression_list (email_address);
```

- `(campaign_id, status)` — ステータス別の集計・取得用（送信ワークフローの完了判定等）
- `(campaign_id, id)` — ページネーション用（Map State でのバッチ読み取り）
- `(ses_message_id)` — SESイベントからの宛先レコード特定用（フォールバック経路）
- `(email_address, status)` — バッチLambdaでのソフトバウンス累計カウント用
- `suppression_list(email_address)` — CSV取込時の抑制リスト突合用（UNIQUE制約兼用）

---

## ER図

```
notification_campaigns (1) ──── (N) notification_recipients
         │                              │
         ├ id (PK)                      ├ id (PK)
         ├ title                        ├ campaign_id (FK)
         ├ subject                      ├ email_address
         ├ body_html                    ├ ses_message_id
         ├ body_text                    ├ status
         ├ from_address                 ├ sent_at
         ├ csv_s3_key                   ├ error_message
         ├ scheduled_at                 ├ bounce_type
         ├ execution_arn                ├ bounce_sub_type
         ├ status                       ├ diagnostic_code
         ├ total_count                  ├ bounce_at
         ├ sent_count                   ├ complaint_type
         ├ failed_count                 ├ complaint_at
         ├ created_at                   ├ created_at
         └ updated_at                   └ updated_at


suppression_list（キャンペーン横断の抑制リスト）
         │
         ├ id (PK)
         ├ email_address (UNIQUE)
         ├ reason
         ├ source_campaign_id
         └ created_at
```

---

## suppression_list（抑制リスト）

Hard Bounceや苦情が発生したアドレスをキャンペーン横断で管理し、以降の送信から除外するためのテーブル。

| カラム名 | 型 | 説明 |
|---|---|---|
| id | BIGINT (PK) | レコードID |
| email_address | VARCHAR(255) UNIQUE | 抑制対象アドレス |
| reason | VARCHAR(20) | hard_bounce / complaint / manual |
| source_campaign_id | BIGINT | 発生元キャンペーンID（参考情報） |
| created_at | TIMESTAMP | 登録日時 |

**reason値:**

| DB格納値 | 意味 |
|---|---|
| hard_bounce | Hard Bounce（恒久的な配信不能）により自動登録 |
| soft_bounce_limit | Soft Bounce が閾値（例: 3回）を超過して自動登録 |
| complaint | 受信者のスパム報告により自動登録 |
| manual | スタッフによる手動登録 |

---

## SESイベント処理設計

### イベントの用途と設計方針

SESイベントの用途は以下の2つ。いずれもリアルタイム性は不要のため、**全イベントを Kinesis Data Firehose → S3 に蓄積する単一パイプライン**で処理する。

| 用途 | 必要なイベント | 処理方式 |
|---|---|---|
| BI（QuickSight）で送信結果の進捗確認 | 全イベント（Send, Delivery, Bounce, Complaint, Open, Click） | S3 → Athena → QuickSight |
| バウンス管理（suppression_list 更新） | Bounce, Complaint | S3 → 定期バッチ Lambda → RDS |

### アーキテクチャ

```
[SES Configuration Set]
  └─ Event Destination: Send, Delivery, Bounce, Complaint, Open, Click
       → [Kinesis Data Firehose]
            → [S3: s3://bucket/ses-events/year=YYYY/month=MM/day=DD/]
                 │
                 ├─ [Athena] → [QuickSight]
                 │    送信進捗ダッシュボード（配信成功率・バウンス率・開封率・クリック率等）
                 │
                 └─ [EventBridge Scheduler] → [Lambda: Bounce Aggregator]
                      → notification_recipients ステータス更新
                      → suppression_list 登録判定
```

イベント駆動（SNS → SQS → Lambda）ではなくバッチ蓄積方式を採用する理由:
- Open/Click を含めると1キャンペーンで数万〜十数万件のイベントが発生する
- イベント駆動では大量のLambda実行が発生し、RDS接続圧とコストが問題になる
- Firehose → S3 方式ではイベント単位のLambda起動が一切発生しない
- バウンス管理もリアルタイム性不要のため、バッチ処理で十分対応可能

### SESメッセージタグ（イベントから宛先レコードを特定するためのキー）

送信Lambda が `SendBulkEmail` 呼び出し時に、SESメッセージタグとして `campaign_id` と `recipient_id` を付与する。
S3 に蓄積されたイベント JSON の `mail.tags` にこれらが含まれるため、バッチ Lambda 側で `notification_recipients` のレコードを直接特定できる。

```json
// SESイベント通知の構造（抜粋）
{
  "notificationType": "Bounce",
  "bounce": {
    "bounceType": "Permanent",
    "bounceSubType": "General",
    "bouncedRecipients": [
      {
        "emailAddress": "user@example.com",
        "status": "5.1.1",
        "diagnosticCode": "smtp; 550 5.1.1 user unknown"
      }
    ],
    "timestamp": "2024-01-01T00:00:00.000Z"
  },
  "mail": {
    "messageId": "abc-123-def",
    "destination": ["user@example.com"],
    "tags": {
      "campaign_id": ["42"],
      "recipient_id": ["12345"]
    }
  }
}
```

`ses_message_id` による逆引きはフォールバック経路として利用する。
送信Lambda が `SendBulkEmail` のレスポンスから各宛先の `MessageId` を `notification_recipients.ses_message_id` に保存しておくことで、タグが取得できない場合でもレコードを特定できる。

### BI: QuickSight による送信結果の可視化

S3 上の SES イベント JSON を Athena テーブルとして定義し、QuickSight から直接クエリする。
RDS にはBI用のカラム（open_count, click_count 等）を持たず、**BI の集計データは S3 + Athena に一元化**する。

```
QuickSight で可視化できる指標:
  - キャンペーン別: 送信数 / 配信成功数 / バウンス数 / 開封数 / クリック数
  - バウンス率・苦情率の推移
  - 開封率・クリック率
```

### バウンス管理: 定期バッチ Lambda による suppression_list 更新

EventBridge Scheduler で定期実行（例: 日次）する Lambda が、Athena 経由で S3 上の Bounce/Complaint イベントを集計し RDS を更新する。

```
Lambda: Bounce Aggregator 処理:
  1. Athena で前回処理以降の Bounce/Complaint イベントを抽出
  2. mail.tags の campaign_id, recipient_id で notification_recipients を特定
     （タグ取得不可の場合は ses_message_id で逆引き）
  3. notification_recipients を更新:
     - status → 'バウンス' or '苦情'
     - bounce_type, bounce_sub_type, diagnostic_code, bounce_at 等を記録
  4. suppression_list 登録判定:
     - Hard Bounce → 即時登録
     - Complaint → 即時登録
     - Soft Bounce → メールアドレス単位で累計バウンス回数をチェック
       → 閾値（例: 3回）以上で登録（reason = 'soft_bounce_limit'）
```

### suppression_list の活用タイミング

CSV取込ワークフロー（State 1: SplitCSV）でバリデーションの一環として突合する:

```
CSV取込フロー:
  1. CSVパース
  2. バリデーション（形式チェック、重複排除）
  3. suppression_list と突合 → 該当アドレスを除外
  4. チャンク分割 & S3保存

  → notification_campaigns.total_count にはsuppression除外後の件数を記録
  → スタッフが送信前に除外件数を確認可能
```
