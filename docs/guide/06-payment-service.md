# 決済サービスの実装

## 目標

SQS を使った非同期の決済サービスを実装し、注文イベントを受け取って決済処理を行います。

---

## 背景情報

### なぜ SQS を使うのか

決済処理は以下の特徴があります：

- **処理時間が長い**: 外部決済 API の呼び出しに時間がかかる
- **失敗の可能性**: ネットワークエラーや決済拒否が発生しうる
- **順序が重要**: 同じ注文の決済は順番に処理したい

SQS を使うことで、これらの課題に対応できます。

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ EventBridge │────▶│     SQS     │────▶│   Lambda    │────▶│ 決済API     │
│  (イベント)  │     │   (Queue)   │     │ (決済処理)   │     │ (外部)      │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
                           │
                           │ 失敗時
                           ▼
                    ┌─────────────┐
                    │     DLQ     │
                    │ (Dead Letter)│
                    └─────────────┘
```

### SQS の主要な特徴

| 特徴                   | 説明                                           |
| ---------------------- | ---------------------------------------------- |
| **メッセージ保持**     | 最大 14 日間メッセージを保持                   |
| **可視性タイムアウト** | 処理中のメッセージを他のコンシューマーから隠す |
| **DLQ**                | 処理失敗したメッセージを別キューに移動         |
| **バッチ処理**         | 複数メッセージを一度に処理可能                 |

### 標準キュー vs FIFO キュー

| 特徴             | 標準キュー          | FIFO キュー              |
| ---------------- | ------------------- | ------------------------ |
| **順序**         | ベストエフォート    | 厳密な順序保証           |
| **重複**         | 少なくとも 1 回配信 | 正確に 1 回配信          |
| **スループット** | 無制限              | 300 TPS（バッチで 3000） |
| **用途**         | 高スループット      | 順序が重要な処理         |

---

## メリット・デメリット

### SQS を使うメリット

| メリット             | 説明                                 |
| -------------------- | ------------------------------------ |
| **バッファリング**   | トラフィックスパイクを吸収           |
| **リトライ**         | 失敗時の自動リトライ                 |
| **スケーラビリティ** | 処理能力を独立してスケール           |
| **耐障害性**         | 決済サービス停止時もメッセージを保持 |

### SQS を使うデメリット

| デメリット     | 説明                          |
| -------------- | ----------------------------- |
| **レイテンシ** | キューイングによる遅延        |
| **複雑性**     | DLQ、可視性タイムアウトの管理 |
| **コスト**     | メッセージ数に応じた課金      |

---

## コードサンプル

### SQS キューの定義（CDK）

```typescript
// lib/constructs/payment-queue.ts
import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export class PaymentQueue extends Construct {
  public readonly queue: sqs.Queue;
  public readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Dead Letter Queue
    this.dlq = new sqs.Queue(this, "PaymentDLQ", {
      queueName: "payment-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    // メインキュー
    this.queue = new sqs.Queue(this, "PaymentQueue", {
      queueName: "payment-queue",
      visibilityTimeout: cdk.Duration.seconds(60), // Lambda timeout + バッファ
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 3, // 3回失敗したらDLQへ
      },
    });
  }
}
```

### EventBridge から SQS へのルーティング（CDK）

```typescript
// lib/eda-stack.ts
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as eventsources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import * as path from "path";

export class EdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // イベントバス
    const eventBus = new events.EventBus(this, "OrderEventBus", {
      eventBusName: "order-events",
    });

    // 決済キュー（DLQ付き）
    const paymentDlq = new sqs.Queue(this, "PaymentDLQ", {
      queueName: "payment-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    const paymentQueue = new sqs.Queue(this, "PaymentQueue", {
      queueName: "payment-queue",
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: paymentDlq,
        maxReceiveCount: 3,
      },
    });

    // EventBridgeルール: OrderCreated → SQS
    const orderCreatedRule = new events.Rule(this, "OrderCreatedToPayment", {
      eventBus: eventBus,
      ruleName: "order-created-to-payment",
      eventPattern: {
        source: ["order-service"],
        detailType: ["OrderCreated"],
      },
    });

    orderCreatedRule.addTarget(new targets.SqsQueue(paymentQueue));

    // 決済処理Lambda
    const paymentProcessor = new nodejs.NodejsFunction(
      this,
      "PaymentProcessor",
      {
        entry: path.join(__dirname, "../lambda/payment-processor/index.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        environment: {
          EVENT_BUS_NAME: eventBus.eventBusName,
        },
      }
    );

    // SQSからLambdaをトリガー
    paymentProcessor.addEventSource(
      new eventsources.SqsEventSource(paymentQueue, {
        batchSize: 1, // 1メッセージずつ処理
        reportBatchItemFailures: true,
      })
    );

    // EventBridgeへの発行権限
    eventBus.grantPutEventsTo(paymentProcessor);
  }
}
```

### 決済処理 Lambda

```typescript
// lambda/payment-processor/index.ts
import { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from "aws-lambda";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";

const eventBridgeClient = new EventBridgeClient({
  endpoint: process.env.LOCALSTACK_HOSTNAME
    ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
    : undefined,
});

const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || "order-events";

interface OrderDetail {
  orderId: string;
  customerId: string;
  totalAmount: number;
}

interface EventBridgeMessage {
  version: string;
  id: string;
  "detail-type": string;
  source: string;
  detail: OrderDetail;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  console.log("Received SQS event:", JSON.stringify(event, null, 2));

  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      // SQSメッセージからEventBridgeイベントを取得
      const eventBridgeMessage: EventBridgeMessage = JSON.parse(record.body);
      const orderDetail = eventBridgeMessage.detail;

      console.log(`Processing payment for order: ${orderDetail.orderId}`);

      // 決済処理（シミュレーション）
      const paymentResult = await processPayment(orderDetail);

      if (paymentResult.success) {
        // 決済成功イベントを発行
        await publishPaymentEvent({
          orderId: orderDetail.orderId,
          customerId: orderDetail.customerId,
          amount: orderDetail.totalAmount,
          status: "COMPLETED",
          transactionId: paymentResult.transactionId,
        });
        console.log(`Payment completed for order: ${orderDetail.orderId}`);
      } else {
        // 決済失敗イベントを発行
        await publishPaymentEvent({
          orderId: orderDetail.orderId,
          customerId: orderDetail.customerId,
          amount: orderDetail.totalAmount,
          status: "FAILED",
          reason: paymentResult.reason,
        });
        console.log(`Payment failed for order: ${orderDetail.orderId}`);
      }
    } catch (error) {
      console.error(`Error processing record ${record.messageId}:`, error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

interface PaymentResult {
  success: boolean;
  transactionId?: string;
  reason?: string;
}

async function processPayment(order: OrderDetail): Promise<PaymentResult> {
  // 実際の決済処理をシミュレート
  // 本番環境では外部決済APIを呼び出す

  console.log(
    `Processing payment of ¥${order.totalAmount} for customer ${order.customerId}`
  );

  // 処理時間をシミュレート
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // 90%の確率で成功（デモ用）
  if (Math.random() > 0.1) {
    return {
      success: true,
      transactionId: `TXN-${Date.now()}`,
    };
  } else {
    return {
      success: false,
      reason: "Insufficient funds",
    };
  }
}

interface PaymentEventDetail {
  orderId: string;
  customerId: string;
  amount: number;
  status: "COMPLETED" | "FAILED";
  transactionId?: string;
  reason?: string;
}

async function publishPaymentEvent(detail: PaymentEventDetail): Promise<void> {
  const detailType =
    detail.status === "COMPLETED" ? "PaymentCompleted" : "PaymentFailed";

  await eventBridgeClient.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: "payment-service",
          DetailType: detailType,
          Detail: JSON.stringify(detail),
          EventBusName: EVENT_BUS_NAME,
        },
      ],
    })
  );

  console.log(`Published ${detailType} event for order: ${detail.orderId}`);
}
```

---

## 課題

### 課題 1: SQS キューの作成

CDK を使用して、決済処理用の SQS キューと DLQ を作成してください。

**要件:**

1. メインキュー名: `payment-queue`
2. DLQ 名: `payment-dlq`
3. 可視性タイムアウト: 60 秒
4. 最大受信回数: 3 回（3 回失敗で DLQ へ）

<details>
<summary>ヒント 1: DLQの設定方法</summary>

```typescript
const dlq = new sqs.Queue(this, "DLQ", {
  queueName: "dlq-name",
});

const queue = new sqs.Queue(this, "Queue", {
  deadLetterQueue: {
    queue: dlq,
    maxReceiveCount: 3,
  },
});
```

</details>

<details>
<summary>ヒント 2: 可視性タイムアウトの設定</summary>

```typescript
visibilityTimeout: cdk.Duration.seconds(60),
```

可視性タイムアウトは、Lambda 関数のタイムアウトより長く設定する必要があります。

</details>

<details>
<summary>回答</summary>

```typescript
// DLQ
const paymentDlq = new sqs.Queue(this, "PaymentDLQ", {
  queueName: "payment-dlq",
  retentionPeriod: cdk.Duration.days(14),
});

// メインキュー
const paymentQueue = new sqs.Queue(this, "PaymentQueue", {
  queueName: "payment-queue",
  visibilityTimeout: cdk.Duration.seconds(60),
  deadLetterQueue: {
    queue: paymentDlq,
    maxReceiveCount: 3,
  },
});
```

確認コマンド:

```bash
npx cdklocal deploy
awslocal sqs list-queues
```

</details>

### 課題 2: EventBridge から SQS へのルーティング

`OrderCreated`イベントを決済キューにルーティングする EventBridge ルールを作成してください。

**要件:**

1. `order-service`からの`OrderCreated`イベントをマッチ
2. ターゲットとして`payment-queue`を設定

<details>
<summary>ヒント: SQSターゲットの設定</summary>

```typescript
import * as targets from "aws-cdk-lib/aws-events-targets";

rule.addTarget(new targets.SqsQueue(queue));
```

</details>

<details>
<summary>回答</summary>

```typescript
const orderCreatedRule = new events.Rule(this, "OrderCreatedToPayment", {
  eventBus: eventBus,
  ruleName: "order-created-to-payment",
  eventPattern: {
    source: ["order-service"],
    detailType: ["OrderCreated"],
  },
});

orderCreatedRule.addTarget(new targets.SqsQueue(paymentQueue));
```

</details>

### 課題 3: 決済処理 Lambda の実装

SQS からメッセージを受け取り、決済処理を行う Lambda 関数を実装してください。

**要件:**

1. SQS イベントから OrderCreated イベントを取得
2. 決済処理を実行（シミュレーション可）
3. 結果に応じて`PaymentCompleted`または`PaymentFailed`イベントを発行
4. バッチ処理の失敗レポートに対応

<details>
<summary>ヒント 1: SQSイベントの構造</summary>

```typescript
// SQSメッセージのbodyにEventBridgeイベントが含まれる
const eventBridgeMessage = JSON.parse(record.body);
const orderDetail = eventBridgeMessage.detail;
```

</details>

<details>
<summary>ヒント 2: バッチ失敗レポート</summary>

```typescript
import { SQSBatchResponse, SQSBatchItemFailure } from "aws-lambda";

const batchItemFailures: SQSBatchItemFailure[] = [];

// 失敗した場合
batchItemFailures.push({ itemIdentifier: record.messageId });

return { batchItemFailures };
```

</details>

<details>
<summary>回答</summary>

「コードサンプル」セクションの `payment-processor/index.ts` を参照してください。

</details>

### 課題 4: 動作確認

デプロイ後、注文を作成して決済処理が実行されることを確認してください。

```bash
# デプロイ
npx cdklocal deploy

# 注文作成
curl -X POST http://localhost:4566/restapis/<api-id>/prod/_user_request_/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "CUST-001",
    "items": [{"productId": "PROD-A", "quantity": 1, "price": 1000}]
  }'

# SQSキューの確認
awslocal sqs get-queue-attributes \
  --queue-url http://sqs.ap-northeast-1.localhost.localstack.cloud:4566/000000000000/payment-queue \
  --attribute-names All

# Lambdaログの確認
awslocal logs filter-log-events \
  --log-group-name "/aws/lambda/EdaStack-PaymentProcessor..." \
  --filter-pattern "Payment"
```

<details>
<summary>回答: 期待されるログ</summary>

```
Processing payment for order: ORD-XXXXXXXX
Processing payment of ¥1000 for customer CUST-001
Published PaymentCompleted event for order: ORD-XXXXXXXX
Payment completed for order: ORD-XXXXXXXX
```

</details>

---

## 可視性タイムアウトの重要性

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    可視性タイムアウトの動作                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  時間 ─────────────────────────────────────────────────────────────▶   │
│                                                                         │
│  メッセージ受信                                                          │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────────────────────────┐                           │
│  │         可視性タイムアウト期間            │                           │
│  │  (他のコンシューマーからは見えない)        │                           │
│  └─────────────────────────────────────────┘                           │
│       │                                     │                           │
│       │ 処理成功 → メッセージ削除            │ タイムアウト → 再配信      │
│       ▼                                     ▼                           │
│  ┌─────────┐                          ┌─────────┐                      │
│  │  完了   │                          │ 再処理  │                      │
│  └─────────┘                          └─────────┘                      │
└─────────────────────────────────────────────────────────────────────────┘
```

**設定のポイント:**

- Lambda 関数のタイムアウト + バッファ時間 = 可視性タイムアウト
- 例: Lambda 30 秒 → 可視性タイムアウト 60 秒

---

## 確認クイズ

<details>
<summary>Q1: SQSの可視性タイムアウトとは何ですか？</summary>

**A1:** メッセージが受信されてから、他のコンシューマーに見えなくなる期間です。この期間内に処理が完了しないと、メッセージは再びキューに戻り、別のコンシューマーが処理できるようになります。

</details>

<details>
<summary>Q2: DLQ（Dead Letter Queue）の役割は？</summary>

**A2:** 指定回数の処理に失敗したメッセージを移動させるキューです。これにより、問題のあるメッセージがメインキューをブロックすることを防ぎ、後で調査・再処理できます。

</details>

<details>
<summary>Q3: reportBatchItemFailuresを有効にする利点は？</summary>

**A3:** バッチ内の一部のメッセージだけが失敗した場合、失敗したメッセージのみを再処理できます。無効の場合、1 つでも失敗するとバッチ全体が再処理されます。

</details>

---

## 次のステップ

次のステップでは、SNS を使ったファンアウトパターンで通知サービスを実装します。

[← イベント発行](./05-event-publishing.md) | [通知サービス →](./07-notification-service.md)
