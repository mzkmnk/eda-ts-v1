# テスト戦略

## 目標

イベント駆動システムのテスト戦略を学び、単体テスト、統合テスト、E2E テストを実装します。

---

## 背景情報

### イベント駆動システムのテストの難しさ

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    テストの課題                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. 非同期性                                                             │
│     └─ イベントの処理完了を待つ必要がある                                  │
│                                                                         │
│  2. 分散性                                                               │
│     └─ 複数のサービスが連携するため、テスト範囲が広い                       │
│                                                                         │
│  3. 結果整合性                                                           │
│     └─ 即座に結果を確認できない                                           │
│                                                                         │
│  4. 外部依存                                                             │
│     └─ AWS サービスへの依存をモック化する必要がある                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### テストピラミッド

```
                    ┌───────────┐
                    │   E2E     │  少数・高コスト
                    │  Tests    │
                    └───────────┘
               ┌─────────────────────┐
               │   Integration       │  中程度
               │      Tests          │
               └─────────────────────┘
          ┌───────────────────────────────┐
          │         Unit Tests            │  多数・低コスト
          │                               │
          └───────────────────────────────┘
```

### テストの種類と目的

| テスト種類     | 目的                         | 対象                            |
| -------------- | ---------------------------- | ------------------------------- |
| **単体テスト** | 個々の関数・クラスの動作確認 | Lambda 関数のビジネスロジック   |
| **統合テスト** | コンポーネント間の連携確認   | Lambda + DynamoDB               |
| **E2E テスト** | システム全体の動作確認       | API → EventBridge → Lambda → DB |

---

## メリット・デメリット

### LocalStack を使ったテストのメリット

| メリット       | 説明                             |
| -------------- | -------------------------------- |
| **コスト削減** | AWS 利用料が発生しない           |
| **高速**       | ローカル実行で高速フィードバック |
| **再現性**     | 環境をリセットして再現可能       |
| **オフライン** | インターネット接続不要           |

### LocalStack を使ったテストのデメリット

| デメリット           | 説明                         |
| -------------------- | ---------------------------- |
| **完全互換ではない** | 一部の AWS 機能が未サポート  |
| **本番との差異**     | 本番環境との微妙な違いがある |
| **セットアップ**     | Docker 環境が必要            |

---

## コードサンプル

### テスト環境のセットアップ

```typescript
// jest.config.js
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": "ts-jest",
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
  testTimeout: 30000,
};
```

```typescript
// test/setup.ts
import { config } from "dotenv";

// テスト用環境変数
process.env.AWS_REGION = "ap-northeast-1";
process.env.AWS_ACCESS_KEY_ID = "test";
process.env.AWS_SECRET_ACCESS_KEY = "test";
process.env.LOCALSTACK_HOSTNAME = "localhost";
```

### 単体テスト（Zod バリデーション）

```typescript
// test/unit/order-validator.test.ts
import {
  validateOrder,
  OrderValidationError,
  CreateOrderRequestSchema,
} from "../../lambda/order-api/validator";

describe("Order Validator", () => {
  describe("validateOrder", () => {
    it("should pass for valid order", () => {
      const order = {
        customerId: "CUST-001",
        items: [{ productId: "PROD-A", quantity: 2, price: 1000 }],
      };

      const result = validateOrder(order);

      expect(result.customerId).toBe("CUST-001");
      expect(result.items).toHaveLength(1);
    });

    it("should throw error for missing customerId", () => {
      const order = {
        items: [{ productId: "PROD-A", quantity: 1, price: 1000 }],
      };

      expect(() => validateOrder(order)).toThrow(OrderValidationError);
      expect(() => validateOrder(order)).toThrow("customerId is required");
    });

    it("should throw error for empty items", () => {
      const order = {
        customerId: "CUST-001",
        items: [],
      };

      expect(() => validateOrder(order)).toThrow(OrderValidationError);
      expect(() => validateOrder(order)).toThrow("items must not be empty");
    });

    it("should throw error for negative price", () => {
      const order = {
        customerId: "CUST-001",
        items: [{ productId: "PROD-A", quantity: 1, price: -100 }],
      };

      expect(() => validateOrder(order)).toThrow(OrderValidationError);
      expect(() => validateOrder(order)).toThrow("price must be non-negative");
    });

    it("should throw error for zero quantity", () => {
      const order = {
        customerId: "CUST-001",
        items: [{ productId: "PROD-A", quantity: 0, price: 1000 }],
      };

      expect(() => validateOrder(order)).toThrow(OrderValidationError);
      expect(() => validateOrder(order)).toThrow("quantity must be positive");
    });

    it("should throw error for missing productId", () => {
      const order = {
        customerId: "CUST-001",
        items: [{ productId: "", quantity: 1, price: 1000 }],
      };

      expect(() => validateOrder(order)).toThrow(OrderValidationError);
      expect(() => validateOrder(order)).toThrow("productId is required");
    });
  });

  describe("CreateOrderRequestSchema", () => {
    it("should parse valid order", () => {
      const order = {
        customerId: "CUST-001",
        items: [{ productId: "PROD-A", quantity: 2, price: 1000 }],
      };

      const result = CreateOrderRequestSchema.safeParse(order);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.customerId).toBe("CUST-001");
      }
    });

    it("should fail for invalid order", () => {
      const order = {
        customerId: "",
        items: [],
      };

      const result = CreateOrderRequestSchema.safeParse(order);

      expect(result.success).toBe(false);
    });
  });
});
```

### バリデーション関数の実装（Zod）

```typescript
// lambda/order-api/validator.ts
import { z } from "zod";

// Zod スキーマ定義
export const OrderItemSchema = z.object({
  productId: z.string().min(1, "productId is required"),
  quantity: z.number().int().positive("quantity must be positive"),
  price: z.number().nonnegative("price must be non-negative"),
});

export const CreateOrderRequestSchema = z.object({
  customerId: z.string().min(1, "customerId is required"),
  items: z.array(OrderItemSchema).min(1, "items must not be empty"),
});

export type OrderItem = z.infer<typeof OrderItemSchema>;
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

// カスタムエラークラス
export class OrderValidationError extends Error {
  constructor(message: string, public readonly errors: z.ZodIssue[]) {
    super(message);
    this.name = "OrderValidationError";
  }
}

// バリデーション関数
export function validateOrder(order: unknown): CreateOrderRequest {
  const result = CreateOrderRequestSchema.safeParse(order);

  if (!result.success) {
    throw new OrderValidationError(
      result.error.errors[0].message,
      result.error.errors
    );
  }

  return result.data;
}
```

### 統合テスト（LocalStack 使用）

```typescript
// test/integration/order-service.test.ts
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { handler } from "../../lambda/order-api/index";
import { APIGatewayProxyEvent } from "aws-lambda";

const dynamoClient = new DynamoDBClient({
  endpoint: "http://localhost:4566",
  region: "ap-northeast-1",
  credentials: {
    accessKeyId: "test",
    secretAccessKey: "test",
  },
});

const docClient = DynamoDBDocumentClient.from(dynamoClient);

describe("Order Service Integration Tests", () => {
  const TABLE_NAME = "Orders-Test";

  beforeAll(async () => {
    // テーブル作成
    try {
      await dynamoClient.send(
        new CreateTableCommand({
          TableName: TABLE_NAME,
          KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }],
          AttributeDefinitions: [
            { AttributeName: "orderId", AttributeType: "S" },
          ],
          BillingMode: "PAY_PER_REQUEST",
        })
      );
    } catch (error: any) {
      if (error.name !== "ResourceInUseException") {
        throw error;
      }
    }

    process.env.TABLE_NAME = TABLE_NAME;
  });

  afterAll(async () => {
    // テーブル削除
    try {
      await dynamoClient.send(
        new DeleteTableCommand({
          TableName: TABLE_NAME,
        })
      );
    } catch (error) {
      // ignore
    }
  });

  describe("POST /orders", () => {
    it("should create a new order", async () => {
      const event: Partial<APIGatewayProxyEvent> = {
        httpMethod: "POST",
        body: JSON.stringify({
          customerId: "CUST-001",
          items: [{ productId: "PROD-A", quantity: 2, price: 1000 }],
        }),
      };

      const result = await handler(event as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(201);

      const body = JSON.parse(result.body);
      expect(body.orderId).toMatch(/^ORD-/);
      expect(body.customerId).toBe("CUST-001");
      expect(body.totalAmount).toBe(2000);
      expect(body.status).toBe("PENDING");

      // DynamoDBに保存されていることを確認
      const saved = await docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: { orderId: body.orderId },
        })
      );

      expect(saved.Item).toBeDefined();
      expect(saved.Item?.customerId).toBe("CUST-001");
    });

    it("should return 400 for invalid request", async () => {
      const event: Partial<APIGatewayProxyEvent> = {
        httpMethod: "POST",
        body: JSON.stringify({
          // customerId missing
          items: [],
        }),
      };

      const result = await handler(event as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
    });
  });

  describe("GET /orders/{orderId}", () => {
    it("should return existing order", async () => {
      // テストデータを作成
      const testOrder = {
        orderId: "ORD-TEST-001",
        customerId: "CUST-001",
        items: [{ productId: "PROD-A", quantity: 1, price: 1000 }],
        totalAmount: 1000,
        status: "PENDING",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await docClient.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: testOrder,
        })
      );

      const event: Partial<APIGatewayProxyEvent> = {
        httpMethod: "GET",
        pathParameters: { orderId: "ORD-TEST-001" },
      };

      const result = await handler(event as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.orderId).toBe("ORD-TEST-001");
      expect(body.customerId).toBe("CUST-001");
    });

    it("should return 404 for non-existing order", async () => {
      const event: Partial<APIGatewayProxyEvent> = {
        httpMethod: "GET",
        pathParameters: { orderId: "ORD-NOT-EXIST" },
      };

      const result = await handler(event as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
    });
  });
});
```

### E2E テスト

```typescript
// test/e2e/order-flow.test.ts
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const eventBridgeClient = new EventBridgeClient({
  endpoint: "http://localhost:4566",
  region: "ap-northeast-1",
});

const sqsClient = new SQSClient({
  endpoint: "http://localhost:4566",
  region: "ap-northeast-1",
});

const dynamoClient = new DynamoDBClient({
  endpoint: "http://localhost:4566",
  region: "ap-northeast-1",
});

const docClient = DynamoDBDocumentClient.from(dynamoClient);

describe("Order Flow E2E Tests", () => {
  const PAYMENT_QUEUE_URL =
    "http://sqs.ap-northeast-1.localhost.localstack.cloud:4566/000000000000/payment-queue";

  it("should route OrderCreated event to payment queue", async () => {
    // イベントを発行
    await eventBridgeClient.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: "order-service",
            DetailType: "OrderCreated",
            Detail: JSON.stringify({
              orderId: "ORD-E2E-001",
              customerId: "CUST-001",
              totalAmount: 5000,
            }),
            EventBusName: "order-events",
          },
        ],
      })
    );

    // SQSにメッセージが届くまで待機
    await waitForMessage(PAYMENT_QUEUE_URL, "ORD-E2E-001", 10000);
  });

  it("should process complete order flow", async () => {
    const orderId = `ORD-E2E-${Date.now()}`;

    // 1. 注文作成イベントを発行
    await eventBridgeClient.send(
      new PutEventsCommand({
        Entries: [
          {
            Source: "order-service",
            DetailType: "OrderCreated",
            Detail: JSON.stringify({
              orderId,
              customerId: "CUST-001",
              totalAmount: 10000,
            }),
            EventBusName: "order-events",
          },
        ],
      })
    );

    // 2. 決済キューにメッセージが届くことを確認
    const paymentMessage = await waitForMessage(
      PAYMENT_QUEUE_URL,
      orderId,
      10000
    );
    expect(paymentMessage).toBeDefined();

    // 3. 決済処理後、通知が送信されることを確認
    // （実際のテストでは通知キューやログを確認）
  });
});

async function waitForMessage(
  queueUrl: string,
  expectedOrderId: string,
  timeoutMs: number
): Promise<any> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      })
    );

    if (response.Messages) {
      for (const message of response.Messages) {
        const body = JSON.parse(message.Body || "{}");
        if (body.detail?.orderId === expectedOrderId) {
          // メッセージを削除
          await sqsClient.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
            })
          );
          return body;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `Message with orderId ${expectedOrderId} not found within ${timeoutMs}ms`
  );
}
```

---

## 課題

### 課題 1: 単体テストの作成

注文バリデーション関数の単体テストを作成してください。

**要件:**

1. 正常なケースのテスト
2. customerId 欠落のテスト
3. items 空配列のテスト
4. 負の価格のテスト

<details>
<summary>ヒント: Jestの基本構文</summary>

```typescript
describe("テストスイート名", () => {
  it("テストケース名", () => {
    expect(actual).toBe(expected);
    expect(() => fn()).toThrow(Error);
  });
});
```

</details>

<details>
<summary>回答</summary>

「コードサンプル」セクションの `order-validator.test.ts` を参照してください。

</details>

### 課題 2: 統合テストの作成

LocalStack を使用して、注文作成 API の統合テストを作成してください。

**要件:**

1. DynamoDB テーブルのセットアップ/クリーンアップ
2. POST /orders のテスト
3. GET /orders/{orderId} のテスト

<details>
<summary>ヒント: LocalStackへの接続</summary>

```typescript
const client = new DynamoDBClient({
  endpoint: "http://localhost:4566",
  region: "ap-northeast-1",
  credentials: {
    accessKeyId: "test",
    secretAccessKey: "test",
  },
});
```

</details>

<details>
<summary>回答</summary>

「コードサンプル」セクションの `order-service.test.ts` を参照してください。

</details>

### 課題 3: テストの実行

作成したテストを実行し、すべてパスすることを確認してください。

```bash
# LocalStackを起動
docker compose up -d

# CDKでリソースをデプロイ
npx cdklocal deploy

# テスト実行
pnpm test

# 特定のテストファイルのみ実行
pnpm test -- --testPathPattern=order-validator
```

<details>
<summary>回答: 期待される出力</summary>

```
 PASS  test/unit/order-validator.test.ts
  Order Validator
    validateOrder
      ✓ should pass for valid order (2 ms)
      ✓ should throw error for missing customerId (1 ms)
      ✓ should throw error for empty items (1 ms)
      ✓ should throw error for negative price (1 ms)
      ✓ should throw error for zero quantity (1 ms)
      ✓ should throw error for missing productId (1 ms)
    CreateOrderRequestSchema
      ✓ should parse valid order (1 ms)
      ✓ should fail for invalid order (1 ms)

 PASS  test/integration/order-service.test.ts
  Order Service Integration Tests
    POST /orders
      ✓ should create a new order (150 ms)
      ✓ should return 400 for invalid request (10 ms)
    GET /orders/{orderId}
      ✓ should return existing order (50 ms)
      ✓ should return 404 for non-existing order (20 ms)

Test Suites: 2 passed, 2 total
Tests:       12 passed, 12 total
```

</details>

---

## テストのベストプラクティス

### 1. テストの独立性

```typescript
// 各テストは独立して実行可能に
beforeEach(async () => {
  // テストデータをリセット
  await clearTable(TABLE_NAME);
});
```

### 2. 適切なアサーション

```typescript
// 具体的なアサーション
expect(result.statusCode).toBe(201);
expect(body.orderId).toMatch(/^ORD-/);

// 曖昧なアサーション（避ける）
expect(result).toBeTruthy();
```

### 3. テストデータの管理

```typescript
// テストデータファクトリ
function createTestOrder(overrides = {}) {
  return {
    customerId: "CUST-001",
    items: [{ productId: "PROD-A", quantity: 1, price: 1000 }],
    ...overrides,
  };
}
```

---

## 確認クイズ

<details>
<summary>Q1: 単体テストと統合テストの違いは？</summary>

**A1:**

- **単体テスト**: 個々の関数やクラスを独立してテスト。外部依存はモック化。高速で多数実行。
- **統合テスト**: 複数のコンポーネントの連携をテスト。実際のサービス（LocalStack）を使用。より現実的だが低速。

</details>

<details>
<summary>Q2: LocalStackを使ったテストのメリットは？</summary>

**A2:**

1. AWS の利用料が発生しない
2. ローカルで高速に実行できる
3. 環境をリセットして再現性のあるテストが可能
4. オフラインでも実行可能

</details>

<details>
<summary>Q3: 非同期処理のテストで注意すべき点は？</summary>

**A3:**

1. 適切なタイムアウトを設定する
2. ポーリングで結果を待つ場合は最大待機時間を設ける
3. async/await を正しく使用する
4. テスト後のクリーンアップを忘れない

</details>

---

## 次のステップ

次のステップでは、本番環境での運用に必要な監視、ログ、ベストプラクティスを学びます。

[← エラーハンドリング](./08-error-handling.md) | [本番考慮事項 →](./10-production-considerations.md)
