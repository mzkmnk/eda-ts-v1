# EventBridge と Lambda の連携

## 目標

EventBridge ルールを作成し、イベントをトリガーに Lambda 関数を実行できるようになります。

---

## 背景情報

### EventBridge と Lambda の連携パターン

EventBridge から Lambda を呼び出す方法は主に 2 つあります：

```
パターン1: 直接呼び出し（Push）
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ EventBridge │────▶│    Rule     │────▶│   Lambda    │
│  Event Bus  │     │  (Pattern)  │     │  Function   │
└─────────────┘     └─────────────┘     └─────────────┘

パターン2: SQS経由（Pull）
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ EventBridge │────▶│    Rule     │────▶│     SQS     │────▶│   Lambda    │
│  Event Bus  │     │  (Pattern)  │     │    Queue    │     │  Function   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

### 直接呼び出しの特徴

| 特徴         | 説明                                            |
| ------------ | ----------------------------------------------- |
| **同期的**   | EventBridge が Lambda を直接呼び出す            |
| **リトライ** | 失敗時は自動リトライ（最大 2 回）               |
| **DLQ**      | 失敗したイベントを Dead Letter Queue に送信可能 |
| **シンプル** | 設定が簡単                                      |

### Lambda 関数が受け取るイベント構造

```typescript
// EventBridgeからLambdaに渡されるイベント
interface EventBridgeEvent<DetailType extends string, Detail> {
  version: string;
  id: string;
  "detail-type": DetailType;
  source: string;
  account: string;
  time: string;
  region: string;
  resources: string[];
  detail: Detail;
}

// 例: OrderCreatedイベント
interface OrderDetail {
  orderId: string;
  customerId: string;
  totalAmount: number;
}

type OrderCreatedEvent = EventBridgeEvent<"OrderCreated", OrderDetail>;
```

---

## メリット・デメリット

### 直接呼び出しのメリット

| メリット           | 説明                     |
| ------------------ | ------------------------ |
| **低レイテンシ**   | 中間キューがないため高速 |
| **シンプルな構成** | 管理するリソースが少ない |
| **コスト効率**     | SQS の料金が不要         |

### 直接呼び出しのデメリット

| デメリット         | 説明                             |
| ------------------ | -------------------------------- |
| **スロットリング** | Lambda 同時実行数の制限に注意    |
| **順序保証なし**   | イベントの処理順序は保証されない |
| **バッチ処理不可** | 1 イベント 1 呼び出し            |

---

## コードサンプル

### Lambda 関数の実装

```typescript
// lambda/order-processor/index.ts
import { EventBridgeEvent, Context } from "aws-lambda";

interface OrderDetail {
  orderId: string;
  customerId: string;
  totalAmount: number;
  items: Array<{
    productId: string;
    quantity: number;
    price: number;
  }>;
}

export const handler = async (
  event: EventBridgeEvent<"OrderCreated", OrderDetail>,
  context: Context
): Promise<void> => {
  console.log("Received event:", JSON.stringify(event, null, 2));

  const { orderId, customerId, totalAmount } = event.detail;

  console.log(`Processing order: ${orderId}`);
  console.log(`Customer: ${customerId}`);
  console.log(`Total: ¥${totalAmount}`);

  // ここに注文処理ロジックを実装
  // 例: DynamoDBへの保存、外部APIの呼び出しなど

  console.log(`Order ${orderId} processed successfully`);
};
```

### CDK で Lambda と EventBridge ルールを定義

```typescript
// lib/eda-stack.ts
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import * as path from "path";

export class EdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // イベントバスの作成
    const eventBus = new events.EventBus(this, "OrderEventBus", {
      eventBusName: "order-events",
    });

    // Lambda関数の作成
    const orderProcessor = new nodejs.NodejsFunction(this, "OrderProcessor", {
      entry: path.join(__dirname, "../lambda/order-processor/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      environment: {
        EVENT_BUS_NAME: eventBus.eventBusName,
      },
    });

    // EventBridgeルールの作成
    const orderCreatedRule = new events.Rule(this, "OrderCreatedRule", {
      eventBus: eventBus,
      ruleName: "order-created-rule",
      eventPattern: {
        source: ["order-service"],
        detailType: ["OrderCreated"],
      },
    });

    // ルールのターゲットとしてLambdaを設定
    orderCreatedRule.addTarget(
      new targets.LambdaFunction(orderProcessor, {
        retryAttempts: 2, // リトライ回数
        maxEventAge: cdk.Duration.hours(1), // イベントの最大保持時間
      })
    );

    // 出力
    new cdk.CfnOutput(this, "OrderProcessorArn", {
      value: orderProcessor.functionArn,
    });
  }
}
```

### 複数のターゲットを持つルール

```typescript
// 1つのイベントを複数のLambdaで処理
const rule = new events.Rule(this, "OrderRule", {
  eventBus: eventBus,
  eventPattern: {
    source: ["order-service"],
    detailType: ["OrderCreated"],
  },
});

// ターゲット1: 注文処理
rule.addTarget(new targets.LambdaFunction(orderProcessor));

// ターゲット2: 在庫更新
rule.addTarget(new targets.LambdaFunction(inventoryUpdater));

// ターゲット3: 通知送信
rule.addTarget(new targets.LambdaFunction(notificationSender));
```

---

## 課題

### 課題 1: Lambda 関数の作成

`OrderCreated`イベントを受け取り、注文情報をログに出力する Lambda 関数を作成してください。

**要件:**

1. イベントから `orderId`, `customerId`, `totalAmount` を取得
2. 取得した情報を CloudWatch Logs に出力
3. TypeScript で型安全に実装

<details>
<summary>ヒント 1: Lambda関数のディレクトリ構造</summary>

```
lambda/
└── order-processor/
    └── index.ts
```

</details>

<details>
<summary>ヒント 2: EventBridgeイベントの型定義</summary>

```typescript
import { EventBridgeEvent } from "aws-lambda";

interface OrderDetail {
  orderId: string;
  customerId: string;
  totalAmount: number;
}

type OrderCreatedEvent = EventBridgeEvent<"OrderCreated", OrderDetail>;
```

</details>

<details>
<summary>回答</summary>

```typescript
// lambda/order-processor/index.ts
import { EventBridgeEvent, Context } from "aws-lambda";

interface OrderDetail {
  orderId: string;
  customerId: string;
  totalAmount: number;
}

export const handler = async (
  event: EventBridgeEvent<"OrderCreated", OrderDetail>,
  context: Context
): Promise<{ statusCode: number; body: string }> => {
  console.log("=== Order Created Event Received ===");
  console.log("Event ID:", event.id);
  console.log("Source:", event.source);
  console.log("Detail Type:", event["detail-type"]);

  const { orderId, customerId, totalAmount } = event.detail;

  console.log("--- Order Details ---");
  console.log("Order ID:", orderId);
  console.log("Customer ID:", customerId);
  console.log("Total Amount:", `¥${totalAmount.toLocaleString()}`);

  return {
    statusCode: 200,
    body: JSON.stringify({ message: `Order ${orderId} processed` }),
  };
};
```

</details>

### 課題 2: EventBridge ルールの作成

CDK を使用して、以下の要件を満たす EventBridge ルールを作成してください。

**要件:**

1. `order-events` イベントバスを監視
2. `source: order-service`, `detail-type: OrderCreated` にマッチ
3. 課題 1 で作成した Lambda 関数をターゲットに設定

<details>
<summary>ヒント 1: NodejsFunctionの使い方</summary>

```typescript
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";

const fn = new nodejs.NodejsFunction(this, "Function", {
  entry: "lambda/order-processor/index.ts",
  handler: "handler",
  runtime: lambda.Runtime.NODEJS_20_X,
});
```

</details>

<details>
<summary>ヒント 2: ルールとターゲットの設定</summary>

```typescript
import * as targets from "aws-cdk-lib/aws-events-targets";

const rule = new events.Rule(this, "Rule", {
  eventBus: eventBus,
  eventPattern: {
    /* パターン */
  },
});

rule.addTarget(new targets.LambdaFunction(fn));
```

</details>

<details>
<summary>回答</summary>

```typescript
// lib/eda-stack.ts
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import * as path from "path";

export class EdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // イベントバス
    const eventBus = new events.EventBus(this, "OrderEventBus", {
      eventBusName: "order-events",
    });

    // Lambda関数
    const orderProcessor = new nodejs.NodejsFunction(this, "OrderProcessor", {
      entry: path.join(__dirname, "../lambda/order-processor/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
    });

    // EventBridgeルール
    const orderCreatedRule = new events.Rule(this, "OrderCreatedRule", {
      eventBus: eventBus,
      ruleName: "order-created-rule",
      eventPattern: {
        source: ["order-service"],
        detailType: ["OrderCreated"],
      },
    });

    // ターゲット設定
    orderCreatedRule.addTarget(new targets.LambdaFunction(orderProcessor));
  }
}
```

</details>

### 課題 3: 動作確認

デプロイ後、テストイベントを発行して Lambda 関数が実行されることを確認してください。

```bash
# デプロイ
npx cdklocal deploy

# テストイベント発行
awslocal events put-events --entries '[
  {
    "Source": "order-service",
    "DetailType": "OrderCreated",
    "Detail": "{\"orderId\": \"ORD-001\", \"customerId\": \"CUST-001\", \"totalAmount\": 5000}",
    "EventBusName": "order-events"
  }
]'

# Lambdaログの確認
awslocal logs describe-log-groups
awslocal logs get-log-events --log-group-name "/aws/lambda/EdaStack-OrderProcessor..." --log-stream-name "..."
```

<details>
<summary>ヒント: ログストリーム名の取得</summary>

```bash
# ロググループ一覧
awslocal logs describe-log-groups

# ログストリーム一覧
awslocal logs describe-log-streams \
  --log-group-name "/aws/lambda/EdaStack-OrderProcessorXXXXX"

# ログイベント取得
awslocal logs get-log-events \
  --log-group-name "/aws/lambda/EdaStack-OrderProcessorXXXXX" \
  --log-stream-name "2024/12/21/[$LATEST]xxxxx"
```

</details>

<details>
<summary>回答: 期待されるログ出力</summary>

```
=== Order Created Event Received ===
Event ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
Source: order-service
Detail Type: OrderCreated
--- Order Details ---
Order ID: ORD-001
Customer ID: CUST-001
Total Amount: ¥5,000
```

</details>

---

## Dead Letter Queue（DLQ）の設定

Lambda 関数が失敗した場合に備えて、DLQ を設定することを推奨します。

```typescript
import * as sqs from "aws-cdk-lib/aws-sqs";

// DLQ用のSQSキュー
const dlq = new sqs.Queue(this, "OrderProcessorDLQ", {
  queueName: "order-processor-dlq",
  retentionPeriod: cdk.Duration.days(14),
});

// ターゲットにDLQを設定
orderCreatedRule.addTarget(
  new targets.LambdaFunction(orderProcessor, {
    deadLetterQueue: dlq,
    retryAttempts: 2,
    maxEventAge: cdk.Duration.hours(1),
  })
);
```

---

## 確認クイズ

<details>
<summary>Q1: EventBridgeからLambdaを呼び出す際のデフォルトのリトライ回数は？</summary>

**A1:** 2 回です。最初の呼び出しが失敗した場合、最大 2 回までリトライされます。

</details>

<details>
<summary>Q2: 1つのEventBridgeルールに複数のターゲットを設定できますか？</summary>

**A2:** はい、できます。1 つのルールに最大 5 つのターゲットを設定でき、マッチしたイベントは全てのターゲットに並列で送信されます。

</details>

<details>
<summary>Q3: Lambda関数がEventBridgeイベントを受け取る際、イベントの詳細データはどのフィールドに格納されていますか？</summary>

**A3:** `event.detail` フィールドに格納されています。`event['detail-type']` はイベントタイプ、`event.source` はイベントソースです。

</details>

---

## 次のステップ

次のステップでは、API Gateway と Lambda、DynamoDB を使って注文サービスを実装します。

[← EventBridge 基礎](./02-eventbridge-basics.md) | [注文サービス実装 →](./04-order-service.md)
