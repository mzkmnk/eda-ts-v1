# EventBridge 基礎

## 目標

Amazon EventBridge の基本概念を理解し、イベントバスとルールを作成できるようになります。

---

## 背景情報

### Amazon EventBridge とは

Amazon EventBridge は、AWS が提供するサーバーレスイベントバスサービスです。アプリケーション、SaaS アプリケーション、AWS サービス間でイベントを簡単にルーティングできます。

```
┌─────────────┐     ┌─────────────────────────────────────┐     ┌─────────────┐
│  Producer   │────▶│           EventBridge               │────▶│  Consumer   │
│             │     │  ┌─────────┐  ┌─────────────────┐  │     │             │
│ (イベント発行)│     │  │Event Bus│  │     Rules       │  │     │(イベント処理) │
└─────────────┘     │  └─────────┘  │ (フィルタリング)  │  │     └─────────────┘
                    │               └─────────────────┘  │
                    └─────────────────────────────────────┘
```

### EventBridge の主要コンポーネント

| コンポーネント    | 説明                                                               |
| ----------------- | ------------------------------------------------------------------ |
| **Event Bus**     | イベントを受け取るパイプライン。デフォルトバスとカスタムバスがある |
| **Rule**          | イベントをフィルタリングし、ターゲットにルーティングする           |
| **Event Pattern** | どのイベントをマッチさせるかを定義する JSON パターン               |
| **Target**        | イベントの送信先（Lambda、SQS、SNS など）                          |

### イベントの構造

EventBridge のイベントは以下の構造を持ちます：

```json
{
  "version": "0",
  "id": "12345678-1234-1234-1234-123456789012",
  "detail-type": "OrderCreated",
  "source": "order-service",
  "account": "000000000000",
  "time": "2024-12-21T10:00:00Z",
  "region": "ap-northeast-1",
  "resources": [],
  "detail": {
    "orderId": "ORD-12345",
    "customerId": "CUST-001",
    "totalAmount": 2000
  }
}
```

| フィールド    | 説明                                |
| ------------- | ----------------------------------- |
| `source`      | イベントの発生元を識別する文字列    |
| `detail-type` | イベントの種類を識別する文字列      |
| `detail`      | イベントの詳細データ（任意の JSON） |

---

## メリット・デメリット

### EventBridge のメリット

| メリット               | 説明                             |
| ---------------------- | -------------------------------- |
| **スキーマレジストリ** | イベントスキーマを自動検出・管理 |
| **豊富なターゲット**   | 20 以上の AWS サービスに直接連携 |
| **イベントアーカイブ** | イベントを保存し、後から再生可能 |
| **サーバーレス**       | インフラ管理不要、従量課金       |
| **高可用性**           | マルチ AZ 構成で 99.99%の SLA    |

### EventBridge のデメリット

| デメリット             | 説明                           |
| ---------------------- | ------------------------------ |
| **イベントサイズ制限** | 最大 256KB                     |
| **スループット制限**   | リージョンごとに制限あり       |
| **順序保証なし**       | イベントの順序は保証されない   |
| **コスト**             | 大量のイベントではコストが増加 |

---

## コードサンプル

### CDK で EventBridge を定義

```typescript
// lib/eda-stack.ts
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";

export class EdaStack extends cdk.Stack {
  public readonly eventBus: events.EventBus;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // カスタムイベントバスの作成
    this.eventBus = new events.EventBus(this, "OrderEventBus", {
      eventBusName: "order-events",
    });

    // イベントバスのARNを出力
    new cdk.CfnOutput(this, "EventBusArn", {
      value: this.eventBus.eventBusArn,
      description: "Order Event Bus ARN",
    });
  }
}
```

### イベントパターンの例

```typescript
// 特定のソースからのイベントをマッチ
const pattern1: events.EventPattern = {
  source: ["order-service"],
};

// 特定のイベントタイプをマッチ
const pattern2: events.EventPattern = {
  source: ["order-service"],
  detailType: ["OrderCreated"],
};

// 詳細フィールドでフィルタリング
const pattern3: events.EventPattern = {
  source: ["order-service"],
  detailType: ["OrderCreated"],
  detail: {
    totalAmount: [{ numeric: [">=", 10000] }], // 10000円以上の注文
  },
};
```

### AWS SDK でイベントを発行

```typescript
// lambda/order/index.ts
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";

const client = new EventBridgeClient({
  endpoint: process.env.LOCALSTACK_HOSTNAME
    ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
    : undefined,
});

export const publishOrderCreatedEvent = async (order: {
  orderId: string;
  customerId: string;
  totalAmount: number;
}) => {
  const command = new PutEventsCommand({
    Entries: [
      {
        Source: "order-service",
        DetailType: "OrderCreated",
        Detail: JSON.stringify(order),
        EventBusName: "order-events",
      },
    ],
  });

  const response = await client.send(command);
  console.log("Event published:", response);
  return response;
};
```

---

## 課題

### 課題 1: イベントバスの作成

CDK を使用して、`order-events`という名前のカスタムイベントバスを作成してください。

**完了条件:**

1. `npx cdklocal deploy` が成功する
2. `awslocal events list-event-buses` で `order-events` が表示される

<details>
<summary>ヒント 1: CDKスタックの基本構造</summary>

```typescript
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";

export class EdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ここにEventBusを追加
  }
}
```

</details>

<details>
<summary>ヒント 2: EventBusの作成方法</summary>

```typescript
new events.EventBus(this, "LogicalId", {
  eventBusName: "バス名",
});
```

</details>

<details>
<summary>回答</summary>

```typescript
// lib/eda-stack.ts
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";

export class EdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const eventBus = new events.EventBus(this, "OrderEventBus", {
      eventBusName: "order-events",
    });

    new cdk.CfnOutput(this, "EventBusArn", {
      value: eventBus.eventBusArn,
    });
  }
}
```

デプロイと確認：

```bash
npx cdklocal bootstrap
npx cdklocal deploy

awslocal events list-event-buses
```

期待される出力：

```json
{
  "EventBuses": [
    {
      "Name": "default",
      "Arn": "arn:aws:events:ap-northeast-1:000000000000:event-bus/default"
    },
    {
      "Name": "order-events",
      "Arn": "arn:aws:events:ap-northeast-1:000000000000:event-bus/order-events"
    }
  ]
}
```

</details>

### 課題 2: イベントの発行

AWS CLI を使用して、作成したイベントバスにテストイベントを発行してください。

```bash
awslocal events put-events --entries '[
  {
    "Source": "order-service",
    "DetailType": "OrderCreated",
    "Detail": "{\"orderId\": \"ORD-001\", \"totalAmount\": 5000}",
    "EventBusName": "order-events"
  }
]'
```

<details>
<summary>ヒント: イベントが発行されたか確認する方法</summary>

現時点ではターゲットが設定されていないため、イベントは発行されても処理されません。
レスポンスの `FailedEntryCount` が `0` であれば成功です。

```json
{
  "FailedEntryCount": 0,
  "Entries": [
    {
      "EventId": "12345678-1234-1234-1234-123456789012"
    }
  ]
}
```

</details>

<details>
<summary>回答: 期待される出力</summary>

```bash
$ awslocal events put-events --entries '[
  {
    "Source": "order-service",
    "DetailType": "OrderCreated",
    "Detail": "{\"orderId\": \"ORD-001\", \"totalAmount\": 5000}",
    "EventBusName": "order-events"
  }
]'

{
    "FailedEntryCount": 0,
    "Entries": [
        {
            "EventId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        }
    ]
}
```

</details>

### 課題 3: イベントパターンの設計

以下の要件を満たすイベントパターンを設計してください：

1. `order-service` からのイベントのみをマッチ
2. `OrderCreated` または `OrderUpdated` のイベントタイプをマッチ
3. `totalAmount` が 1000 以上のイベントのみをマッチ

<details>
<summary>ヒント 1: 複数の値をマッチさせる</summary>

配列を使用すると、OR 条件でマッチできます：

```typescript
detailType: ['OrderCreated', 'OrderUpdated'],
```

</details>

<details>
<summary>ヒント 2: 数値の比較</summary>

`numeric` オペレーターを使用します：

```typescript
detail: {
  totalAmount: [{ numeric: ['>=', 1000] }],
}
```

</details>

<details>
<summary>回答</summary>

```typescript
const eventPattern: events.EventPattern = {
  source: ["order-service"],
  detailType: ["OrderCreated", "OrderUpdated"],
  detail: {
    totalAmount: [{ numeric: [">=", 1000] }],
  },
};
```

このパターンは以下のイベントにマッチします：

- ✅ source: "order-service", detailType: "OrderCreated", totalAmount: 5000
- ✅ source: "order-service", detailType: "OrderUpdated", totalAmount: 1000
- ❌ source: "payment-service", detailType: "OrderCreated", totalAmount: 5000
- ❌ source: "order-service", detailType: "OrderCreated", totalAmount: 500

</details>

---

## イベントパターンの詳細

### 比較演算子

| 演算子         | 説明                 | 例                             |
| -------------- | -------------------- | ------------------------------ |
| `prefix`       | 前方一致             | `{ "prefix": "ORD-" }`         |
| `suffix`       | 後方一致             | `{ "suffix": ".jpg" }`         |
| `anything-but` | 指定値以外           | `{ "anything-but": ["test"] }` |
| `numeric`      | 数値比較             | `{ "numeric": [">=", 100] }`   |
| `exists`       | フィールドの存在確認 | `{ "exists": true }`           |

### 複合条件の例

```typescript
// AND条件（すべての条件を満たす）
const andPattern: events.EventPattern = {
  source: ["order-service"],
  detailType: ["OrderCreated"],
  detail: {
    totalAmount: [{ numeric: [">=", 1000] }],
    customerId: [{ prefix: "VIP-" }],
  },
};

// OR条件（いずれかの条件を満たす）
const orPattern: events.EventPattern = {
  source: ["order-service", "payment-service"], // order-service OR payment-service
};
```

---

## 確認クイズ

<details>
<summary>Q1: EventBridgeのイベントで必須のフィールドは何ですか？</summary>

**A1:** `source`、`detail-type`、`detail` が必須です。`detail` は空のオブジェクト `{}` でも構いません。

</details>

<details>
<summary>Q2: デフォルトイベントバスとカスタムイベントバスの違いは何ですか？</summary>

**A2:**

- **デフォルトイベントバス**: AWS サービスからのイベントを受け取る。各リージョンに 1 つ自動作成される。
- **カスタムイベントバス**: アプリケーション固有のイベント用。複数作成可能で、アクセス制御を細かく設定できる。

</details>

<details>
<summary>Q3: イベントパターンで「1000以上5000以下」を表現するにはどうしますか？</summary>

**A3:**

```typescript
detail: {
  totalAmount: [{ numeric: ['>=', 1000, '<=', 5000] }],
}
```

</details>

---

## 次のステップ

次のステップでは、EventBridge から Lambda 関数を呼び出す方法を学びます。

[← 環境構築](./01-environment-setup.md) | [Lambda 連携 →](./03-lambda-integration.md)
