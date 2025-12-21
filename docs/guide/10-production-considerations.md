# 本番考慮事項

## 目標

イベント駆動システムを本番環境で運用するための監視、ログ、セキュリティ、ベストプラクティスを学びます。

---

## 背景情報

### 本番運用の課題

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    本番運用で考慮すべき点                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. 可観測性（Observability）                                            │
│     ├─ ログ: 何が起きたか                                                │
│     ├─ メトリクス: どれくらい起きたか                                     │
│     └─ トレース: どのように起きたか                                       │
│                                                                         │
│  2. セキュリティ                                                         │
│     ├─ 最小権限の原則                                                    │
│     ├─ 暗号化（転送中・保存時）                                          │
│     └─ シークレット管理                                                  │
│                                                                         │
│  3. パフォーマンス                                                       │
│     ├─ コールドスタート対策                                              │
│     ├─ 同時実行数の管理                                                  │
│     └─ タイムアウト設定                                                  │
│                                                                         │
│  4. コスト最適化                                                         │
│     ├─ 適切なメモリサイズ                                                │
│     ├─ 不要なリソースの削除                                              │
│     └─ リザーブドキャパシティ                                            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 可観測性の 3 本柱

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐              │
│  │    Logs     │     │   Metrics   │     │   Traces    │              │
│  │   (ログ)    │     │ (メトリクス) │     │  (トレース)  │              │
│  └─────────────┘     └─────────────┘     └─────────────┘              │
│        │                   │                   │                       │
│        ▼                   ▼                   ▼                       │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐              │
│  │ CloudWatch  │     │ CloudWatch  │     │   X-Ray     │              │
│  │    Logs     │     │   Metrics   │     │             │              │
│  └─────────────┘     └─────────────┘     └─────────────┘              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## コードサンプル

### 構造化ログの実装（Lambda Powertools）

```typescript
// Lambda Powertools を使用した構造化ログ
// lambda/order-api/index.ts
import { Logger } from "@aws-lambda-powertools/logger";
import { APIGatewayProxyEvent, Context } from "aws-lambda";

const logger = new Logger({
  serviceName: "order-api",
  logLevel: process.env.LOG_LEVEL || "INFO",
  persistentLogAttributes: {
    environment: process.env.ENVIRONMENT || "development",
  },
});

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context
) => {
  // リクエストコンテキストを自動追加
  logger.addContext(context);

  // カスタム属性を追加
  logger.appendKeys({
    path: event.path,
    method: event.httpMethod,
  });

  logger.info("Request received");

  try {
    const result = await processRequest(event);

    logger.info("Request completed", {
      statusCode: result.statusCode,
    });

    return result;
  } catch (error) {
    logger.error("Request failed", error as Error);
    throw error;
  }
};
```

> **Note**: Lambda Powertools の Logger は自動的に JSON 形式で出力し、Lambda コンテキスト（requestId、functionName など）を含めます。

### Lambda 関数での使用例（Lambda Powertools + Middy）

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
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";
import { logMetrics } from "@aws-lambda-powertools/metrics/middleware";

// Powertools インスタンス
const logger = new Logger({ serviceName: "order-api" });
const tracer = new Tracer({ serviceName: "order-api" });
const metrics = new Metrics({
  serviceName: "order-api",
  namespace: "OrderService",
});

const lambdaHandler = async (
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> => {
  // リクエスト情報をログに追加
  logger.appendKeys({
    path: event.path,
    method: event.httpMethod,
  });

  logger.info("Request received");

  try {
    const result = await processRequest(event);

    // カスタムメトリクス
    metrics.addMetric("RequestProcessed", MetricUnit.Count, 1);

    logger.info("Request completed", { statusCode: result.statusCode });

    return result;
  } catch (error) {
    logger.error("Request failed", error as Error);
    metrics.addMetric("RequestFailed", MetricUnit.Count, 1);
    throw error;
  }
};

// Middy でミドルウェアをラップ
export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger, { logEvent: true }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }));
```

### CloudWatch メトリクスの発行（Lambda Powertools）

```typescript
// Lambda Powertools Metrics を使用
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";

const metrics = new Metrics({
  serviceName: "order-api",
  namespace: "OrderService",
});

// 使用例
metrics.addMetric("OrderCreated", MetricUnit.Count, 1);
metrics.addMetric("ProcessingTime", MetricUnit.Milliseconds, 150);
metrics.addMetric("OrderAmount", MetricUnit.Count, 5000);

// ディメンションを追加
metrics.addDimension("Environment", "production");
metrics.addDimension("Operation", "CreateOrder");

// メタデータを追加（メトリクスには含まれないが、ログに出力される）
metrics.addMetadata("orderId", "ORD-12345");

// 高解像度メトリクス（1秒単位）
metrics.addMetric("HighResolutionMetric", MetricUnit.Count, 1);
```

> **Note**: `logMetrics` ミドルウェアを使用すると、Lambda 実行終了時に自動的にメトリクスが CloudWatch に送信されます。

### X-Ray トレーシングの設定（CDK）

```typescript
// lib/eda-stack.ts
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";

// Lambda Powertools 用の共通環境変数
const powertoolsEnv = {
  POWERTOOLS_SERVICE_NAME: "order-api",
  POWERTOOLS_METRICS_NAMESPACE: "OrderService",
  LOG_LEVEL: "INFO",
};

const orderApiFunction = new nodejs.NodejsFunction(this, "OrderApiFunction", {
  entry: "lambda/order-api/index.ts",
  handler: "handler",
  runtime: lambda.Runtime.NODEJS_20_X,
  memorySize: 256,
  tracing: lambda.Tracing.ACTIVE, // X-Ray有効化
  environment: {
    ...powertoolsEnv,
    AWS_XRAY_CONTEXT_MISSING: "LOG_ERROR",
  },
  bundling: {
    minify: true,
    sourceMap: true,
    externalModules: ["@aws-sdk/*"],
  },
});
```

### セキュリティ設定（CDK）

```typescript
// lib/eda-stack.ts
import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as kms from "aws-cdk-lib/aws-kms";
import * as iam from "aws-cdk-lib/aws-iam";

// KMSキーの作成
const encryptionKey = new kms.Key(this, "EncryptionKey", {
  enableKeyRotation: true,
  description: "Encryption key for order service",
});

// 暗号化されたSQSキュー
const paymentQueue = new sqs.Queue(this, "PaymentQueue", {
  queueName: "payment-queue",
  encryption: sqs.QueueEncryption.KMS,
  encryptionMasterKey: encryptionKey,
});

// 最小権限のIAMポリシー
const orderApiFunction = new nodejs.NodejsFunction(this, "OrderApiFunction", {
  // ...
});

// 必要な権限のみ付与
ordersTable.grantReadWriteData(orderApiFunction);
eventBus.grantPutEventsTo(orderApiFunction);
// 不要な権限は付与しない
```

### CloudWatch アラームの設定（CDK）

```typescript
// lib/monitoring-stack.ts
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as lambda from "aws-cdk-lib/aws-lambda";

export class MonitoringStack extends cdk.Stack {
  constructor(
    scope: cdk.App,
    id: string,
    props: { functions: lambda.Function[] }
  ) {
    super(scope, id);

    const alertTopic = new sns.Topic(this, "AlertTopic", {
      topicName: "system-alerts",
    });

    for (const fn of props.functions) {
      // エラー率アラーム
      const errorAlarm = new cloudwatch.Alarm(this, `${fn.node.id}ErrorAlarm`, {
        alarmName: `${fn.functionName}-errors`,
        metric: fn.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: "Sum",
        }),
        threshold: 5,
        evaluationPeriods: 1,
        alarmDescription: `High error rate for ${fn.functionName}`,
      });

      errorAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

      // 実行時間アラーム
      const durationAlarm = new cloudwatch.Alarm(
        this,
        `${fn.node.id}DurationAlarm`,
        {
          alarmName: `${fn.functionName}-duration`,
          metric: fn.metricDuration({
            period: cdk.Duration.minutes(5),
            statistic: "p99",
          }),
          threshold: 10000, // 10秒
          evaluationPeriods: 3,
          alarmDescription: `High latency for ${fn.functionName}`,
        }
      );

      durationAlarm.addAlarmAction(
        new cloudwatch_actions.SnsAction(alertTopic)
      );

      // スロットリングアラーム
      const throttleAlarm = new cloudwatch.Alarm(
        this,
        `${fn.node.id}ThrottleAlarm`,
        {
          alarmName: `${fn.functionName}-throttles`,
          metric: fn.metricThrottles({
            period: cdk.Duration.minutes(5),
            statistic: "Sum",
          }),
          threshold: 1,
          evaluationPeriods: 1,
          alarmDescription: `Throttling detected for ${fn.functionName}`,
        }
      );

      throttleAlarm.addAlarmAction(
        new cloudwatch_actions.SnsAction(alertTopic)
      );
    }
  }
}
```

### CloudWatch ダッシュボード（CDK）

```typescript
// lib/dashboard-stack.ts
import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";

export class DashboardStack extends cdk.Stack {
  constructor(
    scope: cdk.App,
    id: string,
    props: {
      functions: lambda.Function[];
      queues: sqs.Queue[];
    }
  ) {
    super(scope, id);

    const dashboard = new cloudwatch.Dashboard(this, "OrderServiceDashboard", {
      dashboardName: "OrderService",
    });

    // Lambda メトリクス
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Lambda Invocations",
        left: props.functions.map((fn) => fn.metricInvocations()),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "Lambda Errors",
        left: props.functions.map((fn) => fn.metricErrors()),
        width: 12,
      })
    );

    // SQS メトリクス
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "SQS Messages",
        left: props.queues.map((q) =>
          q.metricApproximateNumberOfMessagesVisible()
        ),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: "SQS Age of Oldest Message",
        left: props.queues.map((q) => q.metricApproximateAgeOfOldestMessage()),
        width: 12,
      })
    );
  }
}
```

---

## 課題

### 課題 1: 構造化ログの実装

Lambda 関数に構造化ログを実装してください。

**要件:**

1. JSON 形式でログを出力
2. タイムスタンプ、ログレベル、メッセージを含む
3. リクエスト ID をコンテキストとして含む

<details>
<summary>ヒント: JSON形式のログ出力</summary>

```typescript
console.log(
  JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "INFO",
    message: "Processing order",
    requestId: context.awsRequestId,
  })
);
```

</details>

<details>
<summary>回答</summary>

「コードサンプル」セクションの `logger.ts` を参照してください。

</details>

### 課題 2: CloudWatch アラームの設定

Lambda 関数のエラー率を監視する CloudWatch アラームを設定してください。

**要件:**

1. 5 分間で 5 回以上のエラーでアラーム
2. SNS トピックに通知

<details>
<summary>ヒント: メトリクスアラームの設定</summary>

```typescript
new cloudwatch.Alarm(this, "Alarm", {
  metric: fn.metricErrors(),
  threshold: 5,
  evaluationPeriods: 1,
});
```

</details>

<details>
<summary>回答</summary>

「コードサンプル」セクションの `MonitoringStack` を参照してください。

</details>

### 課題 3: セキュリティ設定の確認

以下のセキュリティ設定を確認・実装してください。

**要件:**

1. SQS キューの暗号化
2. Lambda 関数の最小権限
3. 環境変数の暗号化

<details>
<summary>ヒント: SQS暗号化</summary>

```typescript
new sqs.Queue(this, "Queue", {
  encryption: sqs.QueueEncryption.KMS_MANAGED,
});
```

</details>

<details>
<summary>回答</summary>

「コードサンプル」セクションのセキュリティ設定を参照してください。

</details>

---

## 本番運用のベストプラクティス

### 1. べき等性の確保

```typescript
// 同じイベントを複数回処理しても結果が同じ
async function processOrder(orderId: string): Promise<void> {
  const existing = await getOrder(orderId);
  if (existing?.status === "PROCESSED") {
    logger.info("Order already processed", { orderId });
    return;
  }
  // 処理を続行
}
```

### 2. 適切なタイムアウト設定

```
API Gateway: 29秒（最大）
Lambda: 処理時間 + バッファ
SQS可視性タイムアウト: Lambda タイムアウト × 6
```

### 3. 同時実行数の管理

```typescript
const fn = new lambda.Function(this, "Function", {
  // ...
  reservedConcurrentExecutions: 100, // 最大同時実行数を制限
});
```

### 4. コールドスタート対策

```typescript
// Provisioned Concurrency
const alias = fn.addAlias("live");
alias.addAutoScaling({
  minCapacity: 5,
  maxCapacity: 50,
});
```

---

## 運用チェックリスト

### デプロイ前

- [ ] すべてのテストがパス
- [ ] セキュリティスキャン完了
- [ ] 環境変数の確認
- [ ] IAM 権限の最小化

### デプロイ後

- [ ] ヘルスチェック確認
- [ ] ログ出力確認
- [ ] メトリクス確認
- [ ] アラーム設定確認

### 定期的な確認

- [ ] DLQ のメッセージ確認
- [ ] コスト確認
- [ ] パフォーマンス確認
- [ ] セキュリティパッチ適用

---

## 確認クイズ

<details>
<summary>Q1: 構造化ログのメリットは？</summary>

**A1:**

1. CloudWatch Logs Insights でクエリ可能
2. 自動的にパースして分析できる
3. 一貫したフォーマットで可読性向上
4. アラートやダッシュボードとの連携が容易

</details>

<details>
<summary>Q2: Lambda関数のX-Rayトレーシングを有効にする方法は？</summary>

**A2:** CDK で `tracing: lambda.Tracing.ACTIVE` を設定します。これにより、Lambda 関数の実行時間、外部サービスへの呼び出し、エラーなどを可視化できます。

</details>

<details>
<summary>Q3: SQSキューの暗号化オプションは？</summary>

**A3:**

1. **SQS_MANAGED**: SQS が管理するキーで暗号化（追加コストなし）
2. **KMS_MANAGED**: AWS 管理の KMS キーで暗号化
3. **KMS**: カスタマー管理の KMS キーで暗号化（最も柔軟）

</details>

---

## まとめ

このプロジェクトを通じて、以下を学びました：

1. EDA の概念と開発環境のセットアップ
2. EventBridge の基礎と Lambda 連携
3. 注文サービスの実装とイベント発行
4. SQS と SNS を使った非同期処理
5. エラーハンドリングと DLQ
6. テスト戦略
7. 本番運用の考慮事項

### 次のステップ

- 実際の AWS 環境へのデプロイ
- CI/CD パイプラインの構築
- より複雑なイベントパターンの実装
- SAGA パターンによる分散トランザクション

---

## 参考リソース

- [AWS EventBridge ドキュメント](https://docs.aws.amazon.com/eventbridge/)
- [AWS Lambda ドキュメント](https://docs.aws.amazon.com/lambda/)
- [LocalStack ドキュメント](https://docs.localstack.cloud/)
- [AWS CDK ドキュメント](https://docs.aws.amazon.com/cdk/)

[← テスト戦略](./09-testing-strategy.md) | [イントロダクション →](./00-introduction.md)
