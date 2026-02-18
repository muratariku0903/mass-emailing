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

-- SESイベント紐付け用（バウンス/苦情ハンドラーからの逆引き）
CREATE INDEX idx_recipients_ses_message_id
  ON notification_recipients (ses_message_id);

-- 抑制リストテーブル
CREATE UNIQUE INDEX idx_suppression_email
  ON suppression_list (email_address);
```

- `(campaign_id, status)` — ステータス別の集計・取得用（送信ワークフローの完了判定等）
- `(campaign_id, id)` — ページネーション用（Map State でのバッチ読み取り）
- `(ses_message_id)` — SESイベント通知からの宛先レコード特定用
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
| complaint | 受信者のスパム報告により自動登録 |
| manual | スタッフによる手動登録 |

---

## バウンス・苦情イベントの紐付け設計

### SESイベント通知から宛先レコードへのマッチング

SESからのバウンス/苦情通知は非同期で届く。`notification_recipients` のレコードを特定するため、以下2つの経路を用意する。

**経路1: SESメッセージタグによる直引き（推奨）**

送信Lambda が `SendBulkEmail` 呼び出し時に、SESメッセージタグとして `campaign_id` と `recipient_id` を付与する。
SES通知の `mail.tags` にこれらが含まれるため、ハンドラーLambda側で直接レコードを特定できる。

```json
// SESバウンス通知の構造（抜粋）
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

**経路2: ses_message_id による逆引き（フォールバック）**

送信Lambda が `SendBulkEmail` のレスポンスから各宛先の `MessageId` を `notification_recipients.ses_message_id` に保存する。
タグが取得できない場合でも、`ses_message_id` でレコードを特定できる。

### Configuration Set のイベントタイプ選択

SES Configuration Set では購読するイベントタイプを選択できる。
全イベントを購読するとLambda実行数が送信件数と同等になるため、**Bounce と Complaint のみ**に絞る。

| イベントタイプ | 200K送信あたりの想定件数 | 購読 | 理由 |
|---|---|---|---|
| Send | ~200,000 | **しない** | 送信Lambdaで同期的に把握済み |
| Delivery | ~195,000 | **しない** | 同上 |
| **Bounce** | **~2,000**（1%想定） | **する** | バウンス管理に必須 |
| **Complaint** | **~200**（0.1%想定） | **する** | 苦情管理に必須 |
| Open / Click | 数万〜 | **しない** | トラッキング不要の要件 |

→ 1キャンペーンあたりのイベント数は**最大でも数千件**に収まる。

### イベント処理フロー

```
[SES] → Configuration Set (Bounce/Complaint のみ)
  → [SNS Topic]
    → [SQS Queue]
      → [Lambda: Bounce/Complaint Handler]

Lambda処理:
  1. SQSメッセージからSES通知をパース（BatchSizeにより1回で最大10件）
  2. mail.tags から campaign_id, recipient_id を取得
     （取得できない場合は ses_message_id で notification_recipients を逆引き）
  3. notification_recipients を更新:
     - status → 'バウンス' or '苦情'
     - bounce_type, bounce_sub_type, diagnostic_code, bounce_at 等を記録
  4. bounceType = 'Permanent' or notificationType = 'Complaint' の場合:
     - suppression_list に UPSERT（既存なら無視）
```

### SQS → Lambda のスロットリング設定

バウンスは送信直後に集中するため、SQS → Lambda の同時実行数を制限してRDSへの接続圧を抑制する。

| 設定項目 | 値 | 効果 |
|---|---|---|
| SQS BatchSize | 10 | 1回のLambda実行で最大10件のイベントをまとめて処理 |
| Lambda MaximumConcurrency | 2〜3 | 同時実行数を制限し、RDSへの同時接続を最大3本に抑制 |

**処理量の見積もり（200K送信・バウンス率1%の場合）**:

```
バウンス2,000件 + 苦情200件 = 2,200イベント
÷ BatchSize 10 = 220回のLambda実行
÷ MaximumConcurrency 3 = 最大3並列で処理
→ RDSへの同時接続は常に最大3本
```

送信用Lambda（MaximumConcurrency=4）と合わせても、RDS Proxyの接続プール内に十分収まる。

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
