# 注文サービスの実装

## 目標

API Gateway、Lambda、DynamoDB を使用して、注文を受け付ける RESTful API を実装します。

---

## 背景情報

### 注文サービスのアーキテクチャ

```
┌──────────┐     ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Client  │────▶│ API Gateway │────▶│    Lambda    │────▶│   DynamoDB   │
│          │◀────│   (REST)    │◀────│ (注文処理)    │◀────│  (注文DB)     │
└──────────┘     └─────────────┘     └──────────────┘     └──────────────┘
```

### API 設計

| メソッド | パス              | 説明           |
| -------- | ----------------- | -------------- |
| POST     | /orders           | 新規注文の作成 |
| GET      | /orders/{orderId} | 注文の取得     |
| GET      | /orders           | 注文一覧の取得 |

### DynamoDB テーブル設計

```
テーブル名: Orders
├── PK (Partition Key): orderId (String)
├── customerId (String)
├── items (List)
├── totalAmount (Number)
├── status (String): PENDING | CONFIRMED | SHIPPED | DELIVERED
├── createdAt (String): ISO 8601形式
└── updatedAt (String): ISO 8601形式
```

### なぜ DynamoDB を選ぶのか

| 特徴                 | 説明                                  |
| -------------------- | ------------------------------------- |
| **サーバーレス**     | インフラ管理不要                      |
| **スケーラビリティ** | 自動スケーリング                      |
| **低レイテンシ**     | ミリ秒単位のレスポンス                |
| **イベント連携**     | DynamoDB Streams でイベント駆動が可能 |

---

## メリット・デメリット

### API Gateway + Lambda + DynamoDB の構成

**メリット:**
| メリット | 説明 |
|---------|------|
| **完全サーバーレス** | サーバー管理が不要 |
| **従量課金** | 使った分だけ支払い |
| **自動スケーリング** | トラフィックに応じて自動調整 |
| **高可用性** | マルチ AZ 構成が標準 |

**デメリット:**
| デメリット | 説明 |
|-----------|------|
| **コールドスタート** | 初回呼び出し時に遅延が発生 |
| **実行時間制限** | Lambda 最大 15 分、API Gateway 最大 29 秒 |
| **複雑なクエリ** | DynamoDB は複雑なクエリが苦手 |

---

## コードサンプル

### DynamoDB テーブルの定義（CDK）

```typescript
// lib/constructs/order-table.ts
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export class OrderTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "OrdersTable", {
      tableName: "Orders",
      partitionKey: {
        name: "orderId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // 開発用

      // GSI: 顧客IDで検索
      // globalSecondaryIndexes: [{
      //   indexName: 'CustomerIndex',
      //   partitionKey: { name: 'customerId', type: dynamodb.AttributeType.STRING },
      // }],
    });
  }
}
```

### Lambda 関数の実装

```typescript
// lambda/order-api/index.ts
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const client = new DynamoDBClient({
  endpoint: process.env.LOCALSTACK_HOSTNAME
    ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
    : undefined,
});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.TABLE_NAME || "Orders";

interface OrderItem {
  productId: string;
  quantity: number;
  price: number;
}

interface CreateOrderRequest {
  customerId: string;
  items: OrderItem[];
}

interface Order {
  orderId: string;
  customerId: string;
  items: OrderItem[];
  totalAmount: number;
  status: "PENDING" | "CONFIRMED" | "SHIPPED" | "DELIVERED";
  createdAt: string;
  updatedAt: string;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log("Request:", JSON.stringify(event, null, 2));

  try {
    switch (event.httpMethod) {
      case "POST":
        return await createOrder(event);
      case "GET":
        if (event.pathParameters?.orderId) {
          return await getOrder(event.pathParameters.orderId);
        }
        return await listOrders();
      default:
        return {
          statusCode: 405,
          body: JSON.stringify({ message: "Method not allowed" }),
        };
    }
  } catch (error) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};

async function createOrder(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  if (!event.body) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: "Request body is required" }),
    };
  }

  const request: CreateOrderRequest = JSON.parse(event.body);

  // バリデーション
  if (!request.customerId || !request.items || request.items.length === 0) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: "customerId and items are required" }),
    };
  }

  const totalAmount = request.items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );

  const now = new Date().toISOString();
  const order: Order = {
    orderId: `ORD-${randomUUID().slice(0, 8).toUpperCase()}`,
    customerId: request.customerId,
    items: request.items,
    totalAmount,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: order,
    })
  );

  return {
    statusCode: 201,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order),
  };
}

async function getOrder(orderId: string): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { orderId },
    })
  );

  if (!result.Item) {
    return {
      statusCode: 404,
      body: JSON.stringify({ message: "Order not found" }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result.Item),
  };
}

async function listOrders(): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      Limit: 100,
    })
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orders: result.Items || [] }),
  };
}
```

### API Gateway の定義（CDK）

```typescript
// lib/eda-stack.ts
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import * as path from "path";

export class EdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
        environment: {
          TABLE_NAME: ordersTable.tableName,
        },
      }
    );

    // DynamoDBへのアクセス権限を付与
    ordersTable.grantReadWriteData(orderApiFunction);

    // API Gateway
    const api = new apigateway.RestApi(this, "OrderApi", {
      restApiName: "Order Service",
      description: "Order management API",
    });

    const orders = api.root.addResource("orders");
    const orderIntegration = new apigateway.LambdaIntegration(orderApiFunction);

    // POST /orders
    orders.addMethod("POST", orderIntegration);

    // GET /orders
    orders.addMethod("GET", orderIntegration);

    // GET /orders/{orderId}
    const order = orders.addResource("{orderId}");
    order.addMethod("GET", orderIntegration);

    // 出力
    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "API Gateway URL",
    });
  }
}
```

---

## 課題

### 課題 1: DynamoDB テーブルの作成

CDK を使用して、注文データを保存する DynamoDB テーブルを作成してください。

**要件:**

1. テーブル名: `Orders`
2. パーティションキー: `orderId` (String)
3. オンデマンドキャパシティモード

<details>
<summary>ヒント 1: DynamoDBテーブルの基本構造</summary>

```typescript
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

new dynamodb.Table(this, "Table", {
  tableName: "テーブル名",
  partitionKey: {
    name: "キー名",
    type: dynamodb.AttributeType.STRING,
  },
});
```

</details>

<details>
<summary>ヒント 2: オンデマンドモードの設定</summary>

```typescript
billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
```

</details>

<details>
<summary>回答</summary>

```typescript
const ordersTable = new dynamodb.Table(this, "OrdersTable", {
  tableName: "Orders",
  partitionKey: {
    name: "orderId",
    type: dynamodb.AttributeType.STRING,
  },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});
```

確認コマンド:

```bash
npx cdklocal deploy
awslocal dynamodb list-tables
```

</details>

### 課題 2: 注文作成 API の実装

POST /orders エンドポイントを実装し、注文を作成できるようにしてください。

**要件:**

1. リクエストボディから `customerId` と `items` を受け取る
2. `orderId` を自動生成（例: `ORD-XXXXXXXX`）
3. `totalAmount` を計算
4. DynamoDB に保存
5. 作成した注文をレスポンスとして返す

<details>
<summary>ヒント 1: リクエストボディのパース</summary>

```typescript
const body = JSON.parse(event.body || "{}");
```

</details>

<details>
<summary>ヒント 2: DynamoDBへの書き込み</summary>

```typescript
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

await docClient.send(
  new PutCommand({
    TableName: "Orders",
    Item: order,
  })
);
```

</details>

<details>
<summary>回答</summary>

Lambda 関数のコードは「コードサンプル」セクションの `createOrder` 関数を参照してください。

テストコマンド:

```bash
# API URLを取得
API_URL=$(awslocal apigateway get-rest-apis --query 'items[0].id' --output text)
ENDPOINT="http://localhost:4566/restapis/${API_URL}/prod/_user_request_/orders"

# 注文作成
curl -X POST ${ENDPOINT} \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "CUST-001",
    "items": [
      {"productId": "PROD-A", "quantity": 2, "price": 1000},
      {"productId": "PROD-B", "quantity": 1, "price": 500}
    ]
  }'
```

</details>

### 課題 3: 注文取得 API の実装

GET /orders/{orderId} エンドポイントを実装してください。

**要件:**

1. パスパラメータから `orderId` を取得
2. DynamoDB から注文を検索
3. 見つからない場合は 404 を返す

<details>
<summary>ヒント: パスパラメータの取得</summary>

```typescript
const orderId = event.pathParameters?.orderId;
```

</details>

<details>
<summary>回答</summary>

Lambda 関数のコードは「コードサンプル」セクションの `getOrder` 関数を参照してください。

テストコマンド:

```bash
# 注文取得
curl ${ENDPOINT}/ORD-XXXXXXXX
```

</details>

---

## 動作確認

### デプロイと確認

```bash
# デプロイ
npx cdklocal deploy

# API URLの確認
awslocal apigateway get-rest-apis

# 注文作成
curl -X POST http://localhost:4566/restapis/<api-id>/prod/_user_request_/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "CUST-001",
    "items": [
      {"productId": "PROD-A", "quantity": 2, "price": 1000}
    ]
  }'

# DynamoDBの確認
awslocal dynamodb scan --table-name Orders
```

---

## 確認クイズ

<details>
<summary>Q1: DynamoDBのオンデマンドモードとプロビジョンドモードの違いは？</summary>

**A1:**

- **オンデマンド**: 使用量に応じて自動スケーリング。予測困難なワークロードに適している。
- **プロビジョンド**: 事前にキャパシティを設定。予測可能なワークロードでコスト最適化が可能。

</details>

<details>
<summary>Q2: API GatewayのLambdaプロキシ統合とは？</summary>

**A2:** API Gateway がリクエスト全体を Lambda に渡し、Lambda のレスポンスをそのままクライアントに返す統合方式です。リクエスト/レスポンスのマッピングが不要で、Lambda 側で柔軟に処理できます。

</details>

<details>
<summary>Q3: DynamoDBDocumentClientを使う利点は？</summary>

**A3:** JavaScript のネイティブな型（オブジェクト、配列、数値など）をそのまま使用でき、DynamoDB の属性型（S, N, M など）への変換を自動で行ってくれます。

</details>

---

## 次のステップ

次のステップでは、注文作成時に EventBridge へイベントを発行する機能を追加します。

[← Lambda 連携](./03-lambda-integration.md) | [イベント発行 →](./05-event-publishing.md)
