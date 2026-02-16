# 送信フロー

## 概要

CSV取込完了時に Step Functions（送信ワークフロー）が自動起動し、Wait 状態で指定日時まで待機する。
指定日時到達後、宛先を SQS にエンキュー → Lambda が SES でメール送信 → 完了後にステータス更新を行う。

### 全体フロー

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
    SFn->>RDS: status=送信予約済 確認→送信中 に更新
    end

    rect rgb(240, 240, 255)
    Note over SFn, SQS: State 2-3: バッチ分割 & SQSエンキュー
    SFn->>RDS: 宛先件数取得、バッチ数計算
    SFn->>RDS: Map State: 宛先をページ単位で読取
    SFn->>SQS: 50件ずつSQSメッセージ送信
    SFn->>SQS: 50件ずつSQSメッセージ送信
    end

    rect rgb(240, 255, 240)
    Note over SQS, SES: メール送信処理
    SQS->>Lambda: Event Source Mapping（MaxConcurrency制御）
    Lambda->>SES: SendBulkEmail（50件一括）
    SES-->>Lambda: 送信結果
    Lambda->>RDS: 宛先status→送信済 / 送信失敗
    end

    rect rgb(255, 255, 230)
    Note over SQS, DLQ: 失敗処理
    SQS-->>DLQ: 3回失敗でDLQへ
    DLQ->>Lambda: DLQ処理Lambda
    Lambda->>RDS: 宛先status→送信失敗
    end

    rect rgb(245, 245, 245)
    Note over SFn, RDS: State 4-5: 完了待ち & 最終更新
    loop 60秒間隔
        SFn->>RDS: 未完了（未送信）の宛先件数を確認
    end
    SFn->>RDS: sent_count/failed_count集計、status→送信完了
    end
```

---

## 送信ワークフロー（Step Functions）

```mermaid
flowchart TD
    START([送信ワークフロー開始]) --> S0

    subgraph State0 [State 0: WaitUntilScheduledTime]
        S0["Wait（TimestampPath: $.scheduled_at）<br/>指定日時まで待機"]
    end

    S0 --> S1

    subgraph State1 [State 1: ValidateCampaign]
        S1[Lambda: キャンペーン情報取得]
        S1 --> S1_2{status=送信予約済?}
        S1_2 -->|はい| S1_3[status→送信中 に更新]
        S1_2 -->|いいえ| S1_ERR[エラー: 不正なステータス]
    end

    S1_3 --> S2

    subgraph State2 [State 2: CalculateBatches]
        S2[Lambda: SELECT COUNT で宛先件数取得]
        S2 --> S2_2["バッチ数計算: ceil(200,000 / 5,000) = 40"]
        S2_2 --> S2_3[ページ情報の配列を返す]
    end

    S2_3 --> S3

    subgraph State3 [State 3: EnqueueBatches - Map State]
        S3{Map State<br/>MaxConcurrency = 5}
        S3 --> E1[Lambda: RDSから宛先ページ読取]
        E1 --> E2[50件ずつSQSメッセージ送信]
        E2 --> E3[次のバッチへ]
    end

    E3 --> S4

    subgraph State4 [State 4: WaitForCompletion]
        S4[Wait: 60秒待機]
        S4 --> S4_2[Lambda: 未完了件数を確認]
        S4_2 --> S4_3{残件数 = 0?}
        S4_3 -->|いいえ| S4
        S4_3 -->|はい| S5
    end

    subgraph State5 [State 5: FinalizeCampaign]
        S5[Lambda: sent_count / failed_count 集計]
        S5 --> S5_2[status→送信完了]
    end

    S5_2 --> END([ワークフロー完了])
```

---

## メール送信処理（SQS → Lambda → SES）

```mermaid
flowchart LR
    SQS[SQS<br/>メール送信キュー] -->|Event Source Mapping<br/>BatchSize=1<br/>MaxConcurrency=4| Lambda[Lambda<br/>メール送信]
    Lambda -->|SendBulkEmail<br/>50件一括| SES[AWS SES]
    SES -->|送信結果| Lambda
    Lambda -->|status更新| RDS[(RDS)]

    SQS -->|3回失敗| DLQ[SQS DLQ]
    DLQ --> DLQLambda[Lambda<br/>DLQ処理]
    DLQLambda -->|status→送信失敗| RDS
```

### SQSメッセージ形式

```json
{
  "campaign_id": "xxx",
  "subject": "...",
  "body_html": "...",
  "body_text": "...",
  "from_address": "...",
  "recipients": [
    {"id": 1, "email": "a@example.com"},
    {"id": 2, "email": "b@example.com"}
  ]
}
```

※ 1メッセージあたり最大50件の宛先を含む

### Lambda処理

1. SES SendBulkEmail API を呼び出し（50件一括）
2. レスポンスから各宛先の送信結果を確認
3. RDSに送信ステータスを一括UPDATE
   - 成功: status = 送信済, sent_at = now
   - 失敗: status = 送信失敗, error_message = ...

---

## 失敗処理（DLQ）

| 設定 | 値 |
|---|---|
| maxReceiveCount | 3（3回失敗でDLQへ） |
| visibilityTimeout | 120秒 |

DLQ Lambda の処理:
- メッセージ内の宛先IDを抽出
- RDS: 該当宛先のステータスを `送信失敗` に更新
- CloudWatch: アラーム発火（失敗件数閾値）
