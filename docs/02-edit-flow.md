# 編集フロー

## 概要

送信前のステータスであれば、メール件名・本文・送信日時・宛先CSVを変更できる。
編集には2つのパターンがある。

- **パターンA**: メタデータのみ編集（件名・本文・送信日時）
- **パターンB**: 宛先CSV差し替え（メタデータ編集も同時に可能）

---

## 編集可能なステータス

| 現在のステータス | メタデータ編集 | CSV差し替え | 備考 |
|---|---|---|---|
| 送信予約済 | 可 | 可 | 送信WF待機中（Wait状態）のため編集可能 |
| 取込失敗 | 可 | 可 | CSV再アップロードで復旧可能 |
| 取込中 | **不可** | **不可** | CSV取込中のため排他制御 |
| 送信中 | **不可** | **不可** | 送信処理中 |
| 送信完了 | **不可** | **不可** | 送信完了済み |
| 送信失敗 | **不可** | **不可** | 送信失敗済み |

---

## パターンA: メタデータのみ編集

件名・本文・送信日時のみを変更する場合。宛先は変わらない。

### フロー

```mermaid
sequenceDiagram
    actor スタッフ
    participant UI as UI/Frontend
    participant APIGW as API Gateway
    participant Lambda
    participant RDS
    participant SFn2 as Step Functions<br/>送信WF

    スタッフ->>UI: 件名・本文・送信日時を編集
    UI->>APIGW: PUT /campaigns/{id}（s3_keyなし）
    APIGW->>Lambda:
    Lambda->>RDS: ステータス確認（編集可能か?）

    alt 編集不可ステータス
        Lambda-->>UI: HTTP 409 Conflict
    else 編集可能
        Lambda->>RDS: notification_campaigns UPDATE

        alt 送信予約済 かつ scheduled_at 変更あり
            Lambda->>SFn2: StopExecution（現在の実行を停止）
            Lambda->>SFn2: startExecution（新しいscheduled_atで再起動）
            Lambda->>RDS: 新しいexecution_arnを保存
        end

        Lambda-->>UI: { campaign_id, status }
    end
```

**API**: `PUT /campaigns/{id}`（`s3_key` なし）

- リクエストボディ: `{ subject?, body_html?, body_text?, from_address?, scheduled_at? }`
- ステータスは変化しない
- `送信予約済` かつ `scheduled_at` 変更時: Wait 中の送信WFを停止し、新しい日時で再起動
- メタデータのみの変更（日時変更なし）: 送信WFは Wait 継続（送信開始時にRDSから最新データを読む）
- 宛先の再取込は不要

---

## パターンB: 宛先CSV差し替え

宛先を変更する場合。既存宛先を全削除してから新CSVを取込む。
メタデータの同時編集も可能。

### フロー

```mermaid
sequenceDiagram
    actor スタッフ
    participant UI as UI/Frontend
    participant APIGW as API Gateway
    participant Lambda
    participant S3
    participant RDS
    participant SFn2 as Step Functions<br/>送信WF
    participant SFn as Step Functions<br/>CSV取込WF

    スタッフ->>UI: 新CSVファイル選択 + 編集

    rect rgb(230, 245, 255)
    Note over UI, S3: Presigned URL取得 & 新CSVアップロード
    UI->>APIGW: GET /presigned-url
    APIGW->>Lambda:
    Lambda-->>UI: { s3_key, presigned_url }
    UI->>S3: PUT 新CSV（Presigned URL）
    S3-->>UI: HTTP 200
    end

    rect rgb(255, 240, 240)
    Note over UI, SFn: 編集API & 非同期CSV再取込
    UI->>APIGW: PUT /campaigns/{id}（s3_keyあり）
    APIGW->>Lambda:
    Lambda->>RDS: ステータス確認（編集可能か?）

    alt 編集不可ステータス
        Lambda-->>UI: HTTP 409 Conflict
    else 編集可能
        Lambda->>RDS: UPDATE（status→取込中）

        alt 元status = 送信予約済
            Lambda->>SFn2: StopExecution（送信WF停止）
        end

        Lambda->>SFn: startExecution（非同期）
        Lambda-->>UI: { campaign_id }（即時返却）

        Note over SFn, RDS: バックグラウンドで実行
        SFn->>RDS: 既存宛先DELETE
        SFn->>S3: 新CSV分割
        SFn->>RDS: Map State: 新宛先を並列バッチINSERT
        SFn->>RDS: status→送信予約済, total_count更新
        SFn->>RDS: 送信WF自動起動 + execution_arn保存
    end
    end

    Note over スタッフ: 送信WFが自動でscheduled_atまで待機
```

**API**: `PUT /campaigns/{id}`（`s3_key` あり）

- リクエストボディ: `{ subject?, body_html?, ..., s3_key }` — **s3_key の有無で分岐**
- CSV取込WF完了後、自動で status → `送信予約済` に戻り、送信WFが再起動される
- 元の `scheduled_at` で送信WFが Wait 状態に入る

### 失敗時のリカバリ（エラー種別による分岐）

| エラー種別 | エラー処理 | ステータス |
|---|---|---|
| 人為的エラー（CSV不正） | 全宛先DELETE → status → `取込失敗` | スタッフがCSVを修正して再アップロード |
| システムエラー（AWS障害等） | ステータス更新なし → `取込中` のまま | 運用チームが CloudWatch で検知・対処 |

※ 既存宛先は State 0 で先に削除されるため、どちらのケースでも旧データは残らない

### CSV取込ワークフロー（登録フローと共通）

```mermaid
flowchart LR
    S0[State 0<br/>既存宛先DELETE] --> S1[State 1<br/>CSV分割] --> S2[State 2<br/>Map State<br/>並列INSERT] --> S3[State 3<br/>status→送信予約済<br/>+ 送信WF自動起動]
    S1 --> |CSVバリデーションエラー| ERR[Catch:<br/>全宛先DELETE<br/>→ status→取込失敗]
    S0 & S1 & S2 & S3 --> |システムエラー| SYS[取込中のまま<br/>CloudWatchで検知]
```

---

## ステータス遷移（編集時）

```mermaid
stateDiagram-v2
    state "パターンA（メタデータ編集）" as PatA {
        送信予約済_A: 送信予約済
        取込失敗_A: 取込失敗

        送信予約済_A --> 送信予約済_A : 変化なし\n（日時変更時は送信WF停止→再起動）
        取込失敗_A --> 取込失敗_A : 変化なし
    }

    state "パターンB（CSV差し替え）" as PatB {
        送信予約済_B: 送信予約済
        取込失敗_B: 取込失敗
        取込中_B: 取込中
        送信予約済_B2: 送信予約済

        送信予約済_B --> 取込中_B : CSV差替（送信WF停止）
        取込失敗_B --> 取込中_B : CSV差替（復旧）
        取込中_B --> 送信予約済_B2 : 成功→送信WF自動起動
        取込中_B --> 取込失敗_B : CSVバリデーションエラー→全宛先DELETE
        note right of 取込中_B : システムエラー時は\n取込中のまま滞留\n（CloudWatchで検知）
    }
```

---

## 排他制御

- `取込中` に編集APIが呼ばれた場合は **HTTP 409 Conflict** を返す
- Step Functions 実行中に重複起動を防ぐため、execution name に `campaign_id` を含めて冪等性を確保
- フロントは `取込中` の間は編集ボタンを非活性にする
