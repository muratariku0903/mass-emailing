# メール一斉送信システム設計 - 概要

## Context

スタッフがWeb画面からCSVファイル（宛先メールアドレス20万件）をアップロードし、指定日時に一斉メール送信を行うシステムを設計する。AWS SESを利用し、送信結果のステータス管理も行う。将来的にはバウンス管理等の拡張も見据える。

---

## ステータス定義

### キャンペーンステータス（notification_campaigns.status）

| ステータス | 説明 |
|---|---|
| 取込中 | CSV取込処理中（Step Functions 実行中） |
| 取込失敗 | CSV取込処理でエラーが発生 |
| 送信予約済 | 送信ワークフロー待機中（指定日時まで Wait） |
| 送信中 | メール送信処理中 |
| 送信完了 | 全件送信完了 |
| 送信失敗 | 送信処理でエラーが発生 |

### 宛先ステータス（notification_recipients.status）

| ステータス | 説明 |
|---|---|
| 未送信 | 登録済み、未処理 |
| 送信済 | SESで送信完了 |
| 送信失敗 | 送信処理でエラーが発生 |
| バウンス | 送信後にバウンスが発生（将来拡張） |

### キャンペーンステータス遷移図

```mermaid
stateDiagram-v2
    [*] --> 取込中 : 登録 / CSV差替

    取込中 --> 送信予約済 : CSV取込成功→送信WF自動起動
    取込中 --> 取込失敗 : CSV取込エラー

    取込失敗 --> 取込中 : CSV差替（編集パターンB）

    送信予約済 --> 送信中 : Wait完了→送信開始
    送信予約済 --> 取込中 : CSV差替（送信WF停止 + 再取込）

    送信中 --> 送信完了 : 全件送信完了
    送信中 --> 送信失敗 : 送信処理エラー

    送信完了 --> [*]
    送信失敗 --> [*]

    note right of 送信予約済 : メタデータ編集（パターンA）は\nステータス変化なし\n（日時変更時は送信WF停止→再起動）
```

### 宛先ステータス遷移図

```mermaid
stateDiagram-v2
    [*] --> 未送信 : CSV取込

    未送信 --> 送信済 : SES送信成功
    未送信 --> 送信失敗 : SES送信エラー / DLQ

    送信済 --> バウンス : バウンス通知（将来拡張）

    送信済 --> [*]
    送信失敗 --> [*]
    バウンス --> [*]
```

---

## 全体アーキテクチャ

### 登録フロー

```mermaid
sequenceDiagram
    actor スタッフ
    participant UI as UI/Frontend
    participant APIGW as API Gateway
    participant Lambda as Lambda
    participant S3
    participant RDS
    participant SFn as Step Functions<br/>CSV取込WF
    participant SFn2 as Step Functions<br/>送信WF

    rect rgb(230, 245, 255)
    Note over スタッフ, S3: Step 1-2: Presigned URL取得 & CSVアップロード
    スタッフ->>UI: 登録ボタン押下
    UI->>APIGW: GET /presigned-url
    APIGW->>Lambda:
    Lambda->>S3: Presigned PUT URL生成
    Lambda-->>UI: { s3_key, presigned_url }
    UI->>S3: PUT CSV（Presigned URL直接アップロード）
    S3-->>UI: HTTP 200
    end

    rect rgb(230, 255, 230)
    Note over UI, SFn2: Step 3-4: キャンペーン登録 & 非同期CSV取込 → 送信WF自動起動
    UI->>APIGW: POST /campaigns
    APIGW->>Lambda:
    Lambda->>RDS: キャンペーン作成（status=取込中）
    Lambda->>SFn: startExecution（非同期）
    Lambda-->>UI: { campaign_id }（即時返却）

    SFn->>S3: CSV読取 & チャンク分割保存
    SFn->>RDS: Map State: 宛先を並列バッチINSERT（import_id付き）
    SFn->>RDS: 旧宛先DELETE（旧import_id）
    SFn->>RDS: status → 送信予約済, total_count更新
    SFn->>SFn2: startExecution（scheduled_atまで待機）
    SFn->>RDS: execution_arn保存
    end
```

### 編集フロー

```mermaid
flowchart TD
    START([編集開始]) --> CHECK{s3_keyあり?}

    CHECK -->|なし：パターンA| A1[PUT /campaigns/id]
    A1 --> A2[RDS: メタデータ更新]
    A2 --> A3{送信予約済<br/>かつ日時変更?}
    A3 -->|はい| A4[Step Functions: 実行停止→再起動]
    A3 -->|いいえ| A5([完了：ステータス変化なし])
    A4 --> A5

    CHECK -->|あり：パターンB| B1[GET /presigned-url]
    B1 --> B2[S3に新CSVアップロード]
    B2 --> B3[PUT /campaigns/id + s3_key]
    B3 --> B4[RDS: status → 取込中]
    B4 --> B5{元status=<br/>送信予約済?}
    B5 -->|はい| B6[Step Functions: 送信WF実行停止]
    B5 -->|いいえ| B7[Step Functions: CSV取込WF起動]
    B6 --> B7
    B7 --> B8[CSV分割 → 並列INSERT（新import_id）→ 旧宛先DELETE]
    B8 --> B9[status → 送信予約済 + 送信WF自動再起動]
    B9 --> B10([送信WFがscheduled_atまで待機])
```

### 送信フロー

```mermaid
sequenceDiagram
    participant SFn as Step Functions<br/>送信WF
    participant RDS
    participant SQS
    participant Lambda as Lambda<br/>メール送信
    participant SES as AWS SES
    participant DLQ as SQS DLQ

    rect rgb(255, 250, 240)
    Note over SFn: State 0: 指定日時まで待機
    SFn->>SFn: Wait（scheduled_atまで待機）
    end

    rect rgb(255, 240, 240)
    Note over SFn, RDS: State 1: キャンペーン検証
    SFn->>RDS: status=送信予約済 確認 → 送信中 に更新
    end

    rect rgb(240, 240, 255)
    Note over SFn, SQS: State 2-3: バッチ分割 & SQSエンキュー
    SFn->>RDS: 宛先件数取得、バッチ計算
    SFn->>RDS: Map State: 宛先をページ読取
    SFn->>SQS: 50件ずつSQSメッセージ送信
    SFn->>SQS: 50件ずつSQSメッセージ送信
    end

    rect rgb(240, 255, 240)
    Note over SQS, SES: メール送信処理
    SQS->>Lambda: Event Source Mapping（MaxConcurrency制御）
    Lambda->>SES: SendBulkEmail（50件一括）
    SES-->>Lambda: 送信結果
    Lambda->>RDS: 宛先status → 送信済 / 送信失敗
    end

    rect rgb(255, 255, 230)
    Note over SQS, DLQ: 失敗処理
    SQS-->>DLQ: 3回失敗でDLQへ
    DLQ->>Lambda: DLQ処理Lambda
    Lambda->>RDS: 宛先status → 送信失敗
    end

    rect rgb(245, 245, 245)
    Note over SFn, RDS: State 4-5: 完了待ち & 最終更新
    SFn->>RDS: 60秒ごとに未完了件数を確認（ポーリング）
    SFn->>RDS: sent_count/failed_count集計、status → 送信完了
    end
```

---

## インフラ構成要素

| サービス | 用途 |
|---|---|
| API Gateway | REST API エンドポイント |
| Lambda | 各処理のコンピュート |
| S3 | CSVファイル保存 |
| RDS (MySQL/PostgreSQL) | キャンペーン・宛先データ管理 |
| RDS Proxy | Lambda→RDS接続プーリング（必須） |
| SQS | メール送信キュー + DLQ |
| Step Functions | CSV取込ワークフロー + 送信ワークフロー（2つ） |
| SES | メール送信 |
| CloudWatch | 監視・アラーム |

---

## 関連ドキュメント

| ファイル | 内容 |
|---|---|
| [01-registration-flow.md](./01-registration-flow.md) | 登録フロー詳細 |
| [02-edit-flow.md](./02-edit-flow.md) | 編集フロー詳細 |
| [03-sending-flow.md](./03-sending-flow.md) | 送信フロー詳細 |
| [04-database-design.md](./04-database-design.md) | データベース設計 |
| [05-ses-configuration.md](./05-ses-configuration.md) | SES設定・レート制御 |
| [06-cost-and-testing.md](./06-cost-and-testing.md) | コスト概算・検証方法 |
| [rds-proxy.md](./rds-proxy.md) | RDS Proxy 利用背景と導入手順 |
