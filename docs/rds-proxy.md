# RDS Proxy 利用背景と導入手順

## 1. なぜ RDS Proxy が必要なのか

### Lambda + RDS の根本的な問題

Lambda はリクエストごとに独立したインスタンスが起動し、各インスタンスが個別に DB 接続を確立する。
通常のアプリケーションサーバー（ECS/EC2）であればプロセス内で接続プールを保持できるが、
Lambda はステートレスなため、同時実行数がそのまま DB 接続数に直結する。

```
【Lambda の接続特性】

通常のサーバー:
  アプリ (接続プール: 10本) ──→ RDS
  → 100リクエスト来ても DB 接続は最大10本

Lambda:
  Lambda インスタンス 1 ──→ RDS (1接続)
  Lambda インスタンス 2 ──→ RDS (1接続)
  Lambda インスタンス 3 ──→ RDS (1接続)
  ...
  Lambda インスタンス N ──→ RDS (1接続)
  → 100リクエスト来ると DB 接続も最大100本
```

### 本システムでの接続数シミュレーション

本システムでは複数の Lambda が同時に RDS へアクセスする箇所がある。

```
【CSV取込フロー】
  Step Functions Map State (MaxConcurrency = 5)
  → 最大5つの Lambda が同時に RDS へ INSERT
  → 同時接続数: 最大 5

【メール送信フロー】
  SQS → Lambda (MaximumConcurrency = 4)
  → 最大4つの Lambda が同時に RDS へ UPDATE
  → 同時接続数: 最大 4

【その他】
  CSV取込WF完了 Lambda:       1接続
  完了ポーリング Lambda:      1接続
  DLQ 処理 Lambda:            1接続

【最悪ケースの同時接続数】
  5 + 4 + 3 = 12接続
```

12接続であれば RDS Proxy なしでも動作するように見える。しかし、以下の理由で RDS Proxy は必要になる。

### RDS Proxy が必要な理由

**1. Lambda のコールドスタートによる接続急増**

Lambda インスタンスが入れ替わるたびに新しい DB 接続が確立される。
前のインスタンスの接続がまだ閉じていない状態で新しい接続が作られると、
一時的に想定以上の接続数になる。

```
Lambda A (旧) ── 接続まだ残っている（TCP タイムアウト待ち）
Lambda A (新) ── 新規接続を確立
→ 一時的に2倍の接続が発生
```

**2. 接続の確立・切断コストの削減**

RDS Proxy なしの場合、Lambda 実行のたびに TCP 接続 + TLS ハンドシェイク + DB 認証が発生する。
RDS Proxy は接続をプールで保持し、Lambda からの接続要求を既存の DB 接続に多重化する。

```
【RDS Proxy なし】
各 Lambda 実行: TCP接続(~50ms) + TLS(~30ms) + 認証(~20ms) = ~100ms のオーバーヘッド
20万件送信で4,000回の Lambda 実行 → 累計 ~400秒のオーバーヘッド

【RDS Proxy あり】
Lambda → Proxy: 接続再利用（プール済み）→ オーバーヘッド大幅削減
```

**3. 将来のスケール拡大への備え**

現在は MaxConcurrency を低く設定しているが、SES の送信レート上限を引き上げた場合、
Lambda の同時実行数も増やす必要がある。RDS Proxy があれば DB 側の変更なしにスケール可能。

```
現在:   MaxConcurrency = 4  → 同時4接続
将来:   MaxConcurrency = 20 → 同時20接続
さらに: MaxConcurrency = 50 → 同時50接続
→ RDS Proxy が接続を集約するため、RDS 側の max_connections を超えない
```

**4. フェイルオーバー時の可用性向上**

RDS がフェイルオーバーした場合、RDS Proxy が自動的にスタンバイに接続を切り替える。
Lambda 側のコード変更やエンドポイント変更は不要。フェイルオーバー時間が最大 66% 短縮される。

---

## 2. RDS Proxy の仕組み

### 接続の多重化（Multiplexing）

RDS Proxy の最大の特徴。複数のクライアント接続を少数の DB 接続で処理する。

```
Lambda 1 ──┐
Lambda 2 ──┤                    ┌── DB 接続 A
Lambda 3 ──┼── [RDS Proxy] ────┤
Lambda 4 ──┤   (接続プール)     └── DB 接続 B
Lambda 5 ──┘

→ 5つの Lambda 接続を 2つの DB 接続で処理
  トランザクション完了のたびに DB 接続をプールに返却し、別の Lambda に割り当て
```

### 接続プールのパラメータ

| パラメータ | デフォルト値 | 説明 |
|---|---|---|
| MaxConnectionsPercent | 100 | max_connections に対するプール上限の割合 |
| MaxIdleConnectionsPercent | 50 | プール内のアイドル接続割合の上限 |
| IdleClientTimeout | 1,800秒 (30分) | クライアント接続のアイドルタイムアウト |
| ConnectionBorrowTimeout | 120秒 | 接続取得の待機タイムアウト |

### セッションピン留め（Session Pinning）

特定の条件でクライアント接続が DB 接続に固定され、多重化が無効になる現象。
ピン留めが発生すると接続の再利用効率が低下する。

**主な発生条件:**
- `SET` 文によるセッション変数の変更
- 一時テーブルの作成
- プリペアドステートメントの使用
- ユーザー変数の設定
- 16KB を超える SQL 文

**本システムでの影響:**
本システムの Lambda は単純な INSERT / UPDATE のみを実行するため、
ピン留めが発生するケースはほぼない。ただし、ORM を使用する場合は
自動的に SET 文が発行される可能性があるため注意が必要。

---

## 3. RDS インスタンスの max_connections

RDS Proxy の設計にあたり、接続先 RDS の max_connections を把握する必要がある。

### 計算式

**MySQL:**
```
max_connections = DBInstanceClassMemory / 12582880
```

**PostgreSQL:**
```
max_connections = LEAST(DBInstanceClassMemory / 9531392, 5000)
```

### インスタンスタイプ別のデフォルト値（目安）

| インスタンスタイプ | メモリ | MySQL | PostgreSQL | 用途 |
|---|---|---|---|---|
| db.t3.micro | 1GB | ~60 | ~66 | 開発 |
| db.t3.small | 2GB | ~150 | ~200 | テスト |
| db.t3.medium | 4GB | ~320 | ~400 | 小規模本番 |
| db.t3.large | 8GB | ~600 | ~800 | 中規模本番 |
| db.r5.large | 16GB | ~1,270 | ~1,600 | 大規模本番 |
| db.r5.xlarge | 32GB | ~2,540 | ~3,300 | 大規模本番 |

### 本システムの推奨

20万件規模のメール送信であれば `db.t3.medium`（max_connections ~320〜400）で十分。
RDS Proxy の MaxConnectionsPercent を 50% に設定した場合、プール上限は ~160〜200 接続。
本システムの同時接続数（最大12程度）に対して余裕がある。

```
確認コマンド:
  MySQL:      SHOW VARIABLES LIKE 'max_connections';
  PostgreSQL: SHOW max_connections;
```

---

## 4. 導入手順

### 前提条件

- RDS インスタンスが作成済みであること
- RDS と Lambda が同一 VPC 内に存在すること
- AWS Secrets Manager にDB認証情報が登録済みであること

### Step 1: Secrets Manager にDB認証情報を登録

RDS Proxy は DB 認証に Secrets Manager を使用する。

```
AWS Secrets Manager:
  シークレット名: mass-emailing/rds-credentials
  シークレット値:
  {
    "username": "app_user",
    "password": "xxxxx",
    "engine": "mysql",          ← または "postgres"
    "host": "<RDS エンドポイント>",
    "port": 3306,               ← または 5432
    "dbname": "mass_emailing"
  }
```

### Step 2: RDS Proxy 用 IAM ロールの作成

RDS Proxy が Secrets Manager にアクセスするための IAM ロール。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:<region>:<account-id>:secret:mass-emailing/rds-credentials-*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt"
      ],
      "Resource": "arn:aws:kms:<region>:<account-id>:key/<kms-key-id>",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "secretsmanager.<region>.amazonaws.com"
        }
      }
    }
  ]
}

信頼ポリシー:
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "rds.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

### Step 3: RDS Proxy の作成

```
設定項目:
  プロキシ識別子:     mass-emailing-proxy
  エンジンファミリー: MySQL または PostgreSQL
  IAM ロール:        Step 2 で作成したロール
  Secrets Manager:    mass-emailing/rds-credentials
  VPC:               RDS と同一の VPC
  サブネット:         RDS と同一のプライベートサブネット
  セキュリティグループ: Lambda からのインバウンド許可（3306 or 5432）

接続プール設定:
  MaxConnectionsPercent:     50    ← max_connections の50%をプール上限
  MaxIdleConnectionsPercent: 25    ← アイドル接続は25%まで
  IdleClientTimeout:         300   ← 5分（Lambda は短命なので短めに設定）
  ConnectionBorrowTimeout:   120   ← 接続取得待ち最大120秒
```

### Step 4: セキュリティグループの設定

```
RDS Proxy のセキュリティグループ:
  インバウンド:
    - プロトコル: TCP
    - ポート: 3306 (MySQL) or 5432 (PostgreSQL)
    - ソース: Lambda のセキュリティグループ

RDS のセキュリティグループ:
  インバウンド:
    - プロトコル: TCP
    - ポート: 3306 or 5432
    - ソース: RDS Proxy のセキュリティグループ  ← Lambda からの直接接続は不要
```

### Step 5: Lambda の接続先を RDS Proxy に変更

Lambda の環境変数で接続先エンドポイントを RDS Proxy に向ける。

```
変更前:
  DB_HOST = mass-emailing-db.xxxx.ap-northeast-1.rds.amazonaws.com

変更後:
  DB_HOST = mass-emailing-proxy.proxy-xxxx.ap-northeast-1.rds.amazonaws.com
```

Lambda 側のコード変更は接続先ホスト名の変更のみ。接続ロジックの変更は不要。

### Step 6: Lambda に IAM 認証を設定（推奨）

パスワード認証の代わりに IAM 認証を使用すると、Lambda コードに認証情報を持つ必要がなくなる。

```
Lambda の IAM ロールに追加するポリシー:
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "rds-db:connect",
      "Resource": "arn:aws:rds-db:<region>:<account-id>:dbuser:<proxy-resource-id>/app_user"
    }
  ]
}
```

```
Lambda コード内での接続（Python の例）:

import boto3
import mysql.connector

def get_connection():
    client = boto3.client('rds')
    token = client.generate_db_auth_token(
        DBHostname='mass-emailing-proxy.proxy-xxxx.ap-northeast-1.rds.amazonaws.com',
        Port=3306,
        DBUsername='app_user',
        Region='ap-northeast-1'
    )
    return mysql.connector.connect(
        host='mass-emailing-proxy.proxy-xxxx.ap-northeast-1.rds.amazonaws.com',
        user='app_user',
        password=token,
        database='mass_emailing',
        ssl_ca='/path/to/AmazonRootCA1.pem'  # IAM認証はTLS必須
    )
```

---

## 5. 本システムに合わせた推奨設定

### 接続プール設計

```
RDS インスタンス: db.t3.medium (max_connections ≈ 400)
RDS Proxy MaxConnectionsPercent: 50% → プール上限 ≈ 200接続

本システムの最大同時接続数:
  CSV取込 Map State:    5接続
  メール送信 Lambda:    4接続
  管理系 Lambda:        3接続
  合計:                12接続

プール上限 200 >> 実際の同時接続 12 → 十分な余裕
```

### CloudWatch 監視メトリクス

RDS Proxy 導入後に監視すべきメトリクス。

| メトリクス | 意味 | アラーム閾値の目安 |
|---|---|---|
| DatabaseConnections | Proxy → RDS の実接続数 | max_connections の 80% |
| ClientConnections | Lambda → Proxy のクライアント接続数 | 急増を検知 |
| DatabaseConnectionsCurrentlySessionPinned | ピン留め中の接続数 | 0 以外が続く場合は調査 |
| QueryRequests | クエリリクエスト数 | 異常な急増を検知 |
| AvailabilityPercentage | Proxy の可用性 | 99.9% 未満 |

---

## 6. 制約・注意事項

### 対応 DB エンジン

- MySQL
- PostgreSQL
- MariaDB
- SQL Server
- **Oracle は非対応**

### VPC 要件

- RDS Proxy はパブリックアクセス不可（プライベートサブネットのみ）
- RDS と同一 VPC 内に配置する必要がある
- Lambda も同一 VPC に配置し、VPC Lambda として実行する

### アカウント制限

| 項目 | 上限 |
|---|---|
| AWS アカウントあたりのプロキシ数 | 20 |
| プロキシあたりのエンドポイント数 | 20 |
| プロキシあたりのシークレット数 | 200 |

### クライアント接続の最大有効期間

- RDS Proxy はクライアント接続を最大 **24時間** で強制切断する
- Lambda は短命なため通常は影響なし

### コスト

- vCPU 単位の時間課金（RDS インスタンスの vCPU 数に基づく）
- db.t3.medium (2 vCPU) の場合: 月額約 $20〜30 程度（リージョンにより変動）
- 最新の料金は AWS 公式サイトを参照
