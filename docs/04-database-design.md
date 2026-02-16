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
| status | VARCHAR(20) | 宛先ステータス（下記参照） |
| sent_at | TIMESTAMP | 送信日時 |
| error_message | TEXT | エラーメッセージ |
| created_at | TIMESTAMP | 作成日時 |
| updated_at | TIMESTAMP | 更新日時 |

**宛先ステータス値:**

| DB格納値 | 意味 |
|---|---|
| 未送信 | 登録済み、未処理 |
| 送信済 | SESで送信完了 |
| 送信失敗 | 送信処理でエラー発生 |
| バウンス | 送信後にバウンスが発生（将来拡張） |

---

## インデックス

```sql
-- 宛先テーブル
CREATE INDEX idx_recipients_campaign_status
  ON notification_recipients (campaign_id, status);

CREATE INDEX idx_recipients_campaign_id
  ON notification_recipients (campaign_id, id);

```

- `(campaign_id, status)` — ステータス別の集計・取得用（送信ワークフローの完了判定等）
- `(campaign_id, id)` — ページネーション用（Map State でのバッチ読み取り）

---

## ER図

```
notification_campaigns (1) ──── (N) notification_recipients
         │                              │
         ├ id (PK)                      ├ id (PK)
         ├ title                        ├ campaign_id (FK)
         ├ subject                      ├ email_address
         ├ body_html                    ├ status
         ├ body_text                    ├ sent_at
         ├ from_address                 ├ error_message
         ├ csv_s3_key                   ├ created_at
         ├ scheduled_at                 └ updated_at
         ├ execution_arn
         ├ status
         ├ total_count
         ├ sent_count
         ├ failed_count
         ├ created_at
         └ updated_at
```

---

## 将来拡張: バウンス・苦情管理カラム

将来的に notification_recipients テーブルに以下カラムを追加予定:

| カラム名 | 型 | 説明 |
|---|---|---|
| bounce_type | VARCHAR(20) | Hard / Soft / Undetermined |
| bounce_at | TIMESTAMP | バウンス発生日時 |
| complaint_at | TIMESTAMP | 苦情発生日時 |

```
[SES] → [SNS Topic] → [SQS] → [Lambda: Event Handler]
                                       │
                                       ▼
                                 [RDS: ステータス更新]
                                 - Bounce → バウンス
                                 - Complaint → 抑制リストへ追加
```
