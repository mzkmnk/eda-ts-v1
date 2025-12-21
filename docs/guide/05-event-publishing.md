# イベント発行の実装

## 目標

注文作成時に EventBridge へイベントを発行し、他のサービスが注文イベントを購読できるようにします。

---

## 背景情報

### イベント発行のタイミング

注文サービスでは、以下のタイミングでイベントを発行します：

```
┌─────────────────────────────────────────────────────────────────┐
│                      注文サービス                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  POST /orders                                                   │
│       │                                                         │
│       ▼                                                         │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────────┐   │
│  │ バリデーション │────▶│ DB保存      │────▶│ イベント発行     │   │
│  └─────────────┘     └─────────────┘     │ (OrderCreated)  │   │
│                                          └─────────────────┘   │
│                                                   │             │
└───────────────────────────────────────────────────│─────────────┘
                                                    │
                                                    ▼
                                          ┌─────────────────┐
                                          │  EventBridge    │
                                          │  (order-events) │
                                          └─────────────────┘
                                                    │
                              ┌─────────────────────┼─────────────────────┐
                              │                     │                     │
                              ▼                     ▼                     ▼
                      ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
                      │ 決済サービス  │       │ 在庫サービス  │       │ 通知サービス  │
                      └─────────────┘       └─────────────┘       └─────────────┘
```

### イベント設計のベストプラクティス

| 原則                     | 説明                                   |
| ------------------------ | -------------------------------------- |
| **イベントは事実を表す** | 「注文が作成された」という過去形で命名 |
| **必要十分な情報**       | 消費者が必要とする情報を含める         |
| **イミュータブル**       | 一度発行されたイベントは変更しない     |
| **バージョニング**       | スキーマ変更に備えてバージョンを含める |

### イベントスキーマの設計

```typescript
// OrderCreatedイベントのスキーマ
interface OrderCreatedEvent {
  version: "1.0";
  orderId: string;
  customerId: string;
  items: Array<{
    productId: string;
    quantity: number;
    price: number;
  }>;
  totalAmount: number;
  status: "PENDING";
  createdAt: string;
}
```

---

## メリット・デメリット

### イベント発行パターンのメリット

| メリット     | 説明                                           |
| ------------ | ---------------------------------------------- |
| **疎結合**   | 注文サービスは消費者を知らない                 |
| **拡張性**   | 新しい消費者を追加しても注文サービスは変更不要 |
| **監査証跡** | イベントをアーカイブして監査に利用可能         |
| **リプレイ** | 過去のイベントを再生して状態を再構築可能       |

### イベント発行パターンのデメリット

| デメリット   | 説明                                    |
| ------------ | --------------------------------------- |
| **複雑性**   | イベントスキーマの管理が必要            |
| **デバッグ** | イベントフローの追跡が困難              |
| **整合性**   | DB 保存とイベント発行の整合性確保が課題 |

---

## コードサンプル

### イベント発行ユーティリティ（Lambda Powertools + Zod）

```typescript
// lambda/shared/event-publisher.ts
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { z } from "zod";

const logger = new Logger({ serviceName: "event-publisher" });
const tracer = new Tracer({ serviceName: "event-publisher" });

const client = tracer.captureAWSv3Client(
  new EventBridgeClient({
    endpoint: process.env.LOCALSTACK_HOSTNAME
      ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
      : undefined,
  })
);

const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || "order-events";

// イベントペイロードのスキーマ
const EventPayloadSchema = z.object({
  source: z.string().min(1),
  detailType: z.string().min(1),
  detail: z.record(z.unknown()),
});

export type EventPayload<T extends Record<string, unknown>> = {
  source: string;
  detailType: string;
  detail: T;
};

export async function publishEvent<T extends Record<string, unknown>>(
  payload: EventPayload<T>
): Promise<string> {
  // バリデーション
  const parseResult = EventPayloadSchema.safeParse(payload);
  if (!parseResult.success) {
    logger.error("Invalid event payload", { errors: parseResult.error.errors });
    throw new Error(`Invalid event payload: ${parseResult.error.message}`);
  }

  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment("publishEvent");

  try {
    const command = new PutEventsCommand({
      Entries: [
        {
          Source: payload.source,
          DetailType: payload.detailType,
          Detail: JSON.stringify(payload.detail),
          EventBusName: EVENT_BUS_NAME,
        },
      ],
    });

    const response = await client.send(command);

    if (response.FailedEntryCount && response.FailedEntryCount > 0) {
      const failedEntry = response.Entries?.[0];
      logger.error("Failed to publish event", {
        errorCode: failedEntry?.ErrorCode,
        errorMessage: failedEntry?.ErrorMessage,
      });
      throw new Error(`Failed to publish event: ${failedEntry?.ErrorMessage}`);
    }

    const eventId = response.Entries?.[0]?.EventId || "unknown";

    logger.info("Event published successfully", {
      source: payload.source,
      detailType: payload.detailType,
      eventId,
    });

    subsegment?.addAnnotation("eventId", eventId);
    subsegment?.addAnnotation("detailType", payload.detailType);

    return eventId;
  } finally {
    subsegment?.close();
  }
}
```

### 注文作成時のイベント発行（Lambda Powertools + Zod + Middy）

```typescript
// lambda/order-api/index.ts
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import middy from "@middy/core";
import httpJsonBodyParser from "@middy/http-json-body-parser";
import httpErrorHandler from "@middy/http-error-handler";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";
import { logMetrics } from "@aws-lambda-powertools/metrics/middleware";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { publishEvent } from "../shared/event-publisher";
import { z } from "zod";
import { randomUUID } from "crypto";
import createHttpError from "http-errors";

const logger = new Logger({ serviceName: "order-api" });
const tracer = new Tracer({ serviceName: "order-api" });
const metrics = new Metrics({
  serviceName: "order-api",
  namespace: "OrderService",
});

const dynamoClient = tracer.captureAWSv3Client(
  new DynamoDBClient({
    endpoint: process.env.LOCALSTACK_HOSTNAME
      ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
      : undefined,
  })
);
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = process.env.TABLE_NAME || "Orders";

// Zod スキーマ
const OrderItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().positive(),
  price: z.number().nonnegative(),
});

const CreateOrderRequestSchema = z.object({
  customerId: z.string().min(1),
  items: z.array(OrderItemSchema).min(1),
});

// OrderCreated イベントのスキーマ
const OrderCreatedEventSchema = z.object({
  version: z.literal("1.0"),
  orderId: z.string(),
  customerId: z.string(),
  items: z.array(OrderItemSchema),
  totalAmount: z.number(),
  status: z.literal("PENDING"),
  createdAt: z.string(),
});

type OrderCreatedEvent = z.infer<typeof OrderCreatedEventSchema>;

interface Order {
  orderId: string;
  customerId: string;
  items: z.infer<typeof OrderItemSchema>[];
  totalAmount: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const lambdaHandler = async (
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> => {
  if (event.httpMethod === "POST") {
    return await createOrder(event);
  }
  throw createHttpError(405, "Method not allowed");
};

async function createOrder(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const parseResult = CreateOrderRequestSchema.safeParse(event.body);

  if (!parseResult.success) {
    logger.warn("Validation failed", { errors: parseResult.error.errors });
    throw createHttpError(400, parseResult.error.errors[0].message);
  }

  const body = parseResult.data;
  const totalAmount = body.items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );

  const now = new Date().toISOString();
  const order: Order = {
    orderId: `ORD-${randomUUID().slice(0, 8).toUpperCase()}`,
    customerId: body.customerId,
    items: body.items,
    totalAmount,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  };

  tracer.putAnnotation("orderId", order.orderId);

  // Step 1: DynamoDBに保存
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: order,
    })
  );

  logger.info("Order saved to DynamoDB", { orderId: order.orderId });

  // Step 2: イベントを発行
  const eventDetail: OrderCreatedEvent = {
    version: "1.0",
    orderId: order.orderId,
    customerId: order.customerId,
    items: order.items,
    totalAmount: order.totalAmount,
    status: "PENDING",
    createdAt: order.createdAt,
  };

  const eventId = await publishEvent({
    source: "order-service",
    detailType: "OrderCreated",
    detail: eventDetail,
  });

  logger.info("OrderCreated event published", {
    orderId: order.orderId,
    eventId,
  });

  metrics.addMetric("OrderCreated", MetricUnit.Count, 1);
  metrics.addMetric("OrderAmount", MetricUnit.Count, totalAmount);

  return {
    statusCode: 201,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order),
  };
}

export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger, { logEvent: true }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }))
  .use(httpJsonBodyParser())
  .use(httpErrorHandler());
```

### CDK で EventBridge 権限を付与

```typescript
// lib/eda-stack.ts
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";
import * as path from "path";

export class EdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Lambda Powertools 用の共通環境変数
    const powertoolsEnv = {
      POWERTOOLS_SERVICE_NAME: "order-api",
      POWERTOOLS_METRICS_NAMESPACE: "OrderService",
      LOG_LEVEL: "INFO",
    };

    // イベントバス
    const eventBus = new events.EventBus(this, "OrderEventBus", {
      eventBusName: "order-events",
    });

    // DynamoDBテーブル
    const ordersTable = new dynamodb.Table(this, "OrdersTable", {
      tableName: "Orders",
      partitionKey: {
        name: "orderId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Lambda関数
    const orderApiFunction = new nodejs.NodejsFunction(
      this,
      "OrderApiFunction",
      {
        entry: path.join(__dirname, "../lambda/order-api/index.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        tracing: lambda.Tracing.ACTIVE,
        environment: {
          ...powertoolsEnv,
          TABLE_NAME: ordersTable.tableName,
          EVENT_BUS_NAME: eventBus.eventBusName,
        },
        bundling: {
          minify: true,
          sourceMap: true,
          externalModules: ["@aws-sdk/*"],
        },
      }
    );

    // 権限付与
    ordersTable.grantReadWriteData(orderApiFunction);
    eventBus.grantPutEventsTo(orderApiFunction); // EventBridgeへの発行権限

    // API Gateway
    const api = new apigateway.RestApi(this, "OrderApi", {
      restApiName: "Order Service",
    });

    const orders = api.root.addResource("orders");
    orders.addMethod(
      "POST",
      new apigateway.LambdaIntegration(orderApiFunction)
    );
    orders.addMethod("GET", new apigateway.LambdaIntegration(orderApiFunction));

    const order = orders.addResource("{orderId}");
    order.addMethod("GET", new apigateway.LambdaIntegration(orderApiFunction));

    // 出力
    new cdk.CfnOutput(this, "EventBusArn", {
      value: eventBus.eventBusArn,
    });
    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.url,
    });
  }
}
```

---

## 課題

### 課題 1: イベント発行ユーティリティの作成

再利用可能なイベント発行ユーティリティを作成してください。

**要件:**

1. EventBridgeClient を使用
2. LocalStack 対応（環境変数でエンドポイント切り替え）
3. 発行失敗時にエラーをスロー
4. 発行成功時にログ出力

<details>
<summary>ヒント 1: EventBridgeClientの初期化</summary>

```typescript
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";

const client = new EventBridgeClient({
  endpoint: process.env.LOCALSTACK_HOSTNAME
    ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
    : undefined,
});
```

</details>

<details>
<summary>ヒント 2: PutEventsCommandの使い方</summary>

```typescript
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";

const command = new PutEventsCommand({
  Entries: [
    {
      Source: "source",
      DetailType: "type",
      Detail: JSON.stringify(data),
      EventBusName: "bus-name",
    },
  ],
});
```

</details>

<details>
<summary>回答</summary>

「コードサンプル」セクションの `event-publisher.ts` を参照してください。

</details>

### 課題 2: 注文作成 API へのイベント発行追加

前のステップで作成した注文作成 API に、イベント発行機能を追加してください。

**要件:**

1. DynamoDB 保存後にイベントを発行
2. イベントには注文の全情報を含める
3. source: `order-service`
4. detailType: `OrderCreated`

<details>
<summary>ヒント: イベント発行のタイミング</summary>

```typescript
// 1. DynamoDBに保存
await docClient.send(new PutCommand({ ... }));

// 2. イベントを発行
await publishEvent({ ... });

// 3. レスポンスを返す
return { statusCode: 201, body: JSON.stringify(order) };
```

</details>

<details>
<summary>回答</summary>

「コードサンプル」セクションの `createOrder` 関数を参照してください。

</details>

### 課題 3: イベント発行の動作確認

イベントが正しく発行されることを確認してください。

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

# Lambdaログでイベント発行を確認
awslocal logs filter-log-events \
  --log-group-name "/aws/lambda/EdaStack-OrderApiFunction..." \
  --filter-pattern "Event published"
```

<details>
<summary>ヒント: イベントを受け取るテスト用Lambdaの作成</summary>

イベントが発行されていることを確認するため、前のステップで作成した Lambda 関数をターゲットに設定します。

```bash
# ルールの確認
awslocal events list-rules --event-bus-name order-events

# ターゲットの確認
awslocal events list-targets-by-rule \
  --rule order-created-rule \
  --event-bus-name order-events
```

</details>

<details>
<summary>回答: 期待されるログ</summary>

```
Event published successfully: {
  source: 'order-service',
  detailType: 'OrderCreated',
  eventId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
}
```

</details>

---

## トランザクションの考慮事項

### 問題: DB 保存とイベント発行の整合性

```
シナリオ1: DB保存成功 → イベント発行失敗
  → DBには注文があるが、他サービスは知らない

シナリオ2: DB保存成功 → イベント発行成功 → レスポンス前にクラッシュ
  → クライアントはエラーを受け取るが、注文は作成されている
```

### 解決策: Outbox パターン

```
┌─────────────────────────────────────────────────────────────┐
│                    注文サービス                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐     ┌─────────────────────────────────┐   │
│  │ 注文作成     │────▶│ トランザクション                  │   │
│  │ リクエスト   │     │  ├─ Orders テーブルに保存        │   │
│  └─────────────┘     │  └─ Outbox テーブルに保存        │   │
│                      └─────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Outbox Processor (別プロセス)                        │   │
│  │  ├─ Outboxテーブルを監視                            │   │
│  │  ├─ 未送信イベントをEventBridgeに発行               │   │
│  │  └─ 発行済みフラグを更新                            │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

> **Note**: Outbox パターンの実装は高度なトピックです。このプロジェクトでは簡略化のため、シンプルな実装を採用しています。

---

## 確認クイズ

<details>
<summary>Q1: イベント名を過去形（OrderCreated）にする理由は？</summary>

**A1:** イベントは「すでに起こった事実」を表すためです。「OrderCreate」（命令形）ではなく「OrderCreated」（過去形）とすることで、イベントが不変であることを明示します。

</details>

<details>
<summary>Q2: eventBus.grantPutEventsTo() は何を行いますか？</summary>

**A2:** 指定した Lambda 関数に対して、EventBridge へイベントを発行するための IAM 権限（`events:PutEvents`）を付与します。

</details>

<details>
<summary>Q3: DB保存とイベント発行の整合性を保つ方法は？</summary>

**A3:** Outbox パターンを使用します。注文とイベントを同じトランザクションで DB に保存し、別プロセスでイベントを EventBridge に発行します。これにより、DB 保存とイベント発行の原子性を確保できます。

</details>

---

## 次のステップ

次のステップでは、SQS を使った非同期の決済サービスを実装します。

[← 注文サービス](./04-order-service.md) | [決済サービス →](./06-payment-service.md)
