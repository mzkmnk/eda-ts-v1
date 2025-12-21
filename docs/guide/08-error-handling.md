# エラーハンドリング

## 目標

イベント駆動システムにおけるエラーハンドリング戦略を学び、Dead Letter Queue（DLQ）を使った堅牢なエラー処理を実装します。

---

## 背景情報

### イベント駆動システムのエラーパターン

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    エラーの種類と対処                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. 一時的エラー（Transient Errors）                                     │
│     ├─ ネットワークタイムアウト                                          │
│     ├─ サービス一時停止                                                  │
│     └─ 対処: リトライで解決                                              │
│                                                                         │
│  2. 永続的エラー（Permanent Errors）                                     │
│     ├─ 不正なデータ形式                                                  │
│     ├─ ビジネスルール違反                                                │
│     └─ 対処: DLQに移動、手動対応                                         │
│                                                                         │
│  3. ポイズンメッセージ（Poison Messages）                                 │
│     ├─ 処理不可能なメッセージ                                            │
│     ├─ 無限リトライの原因                                                │
│     └─ 対処: DLQに移動、調査                                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Dead Letter Queue（DLQ）とは

処理に失敗したメッセージを隔離するためのキューです。

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│    SQS      │────▶│   Lambda    │     │    DLQ      │
│   Queue     │     │  (処理失敗)  │────▶│ (隔離キュー) │
└─────────────┘     └─────────────┘     └─────────────┘
      │                                        │
      │ リトライ                                │ 調査・再処理
      └────────────────────────────────────────┘
```

### リトライ戦略

| 戦略                 | 説明                       | 用途           |
| -------------------- | -------------------------- | -------------- |
| **即時リトライ**     | 失敗後すぐにリトライ       | 一時的なエラー |
| **指数バックオフ**   | リトライ間隔を指数的に増加 | 負荷軽減       |
| **最大リトライ回数** | 一定回数で諦める           | 無限ループ防止 |

---

## メリット・デメリット

### DLQ を使うメリット

| メリット       | 説明                                           |
| -------------- | ---------------------------------------------- |
| **障害の隔離** | 問題のあるメッセージがシステムをブロックしない |
| **調査可能**   | 失敗したメッセージを後から分析できる           |
| **再処理**     | 問題解決後にメッセージを再処理可能             |
| **監視**       | DLQ の深さでエラー率を監視                     |

### DLQ を使うデメリット

| デメリット       | 説明                       |
| ---------------- | -------------------------- |
| **運用負荷**     | DLQ の監視と対応が必要     |
| **データ整合性** | 再処理時の順序や重複に注意 |
| **コスト**       | 追加のキューリソース       |

---

## コードサンプル

### 包括的なエラーハンドリング（CDK）

```typescript
// lib/eda-stack.ts
import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as eventsources from "aws-cdk-lib/aws-lambda-event-sources";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatch_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import * as path from "path";

export class EdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // アラート用SNSトピック
    const alertTopic = new sns.Topic(this, "AlertTopic", {
      topicName: "system-alerts",
    });

    // 決済DLQ
    const paymentDlq = new sqs.Queue(this, "PaymentDLQ", {
      queueName: "payment-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    // 決済キュー
    const paymentQueue = new sqs.Queue(this, "PaymentQueue", {
      queueName: "payment-queue",
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: paymentDlq,
        maxReceiveCount: 3,
      },
    });

    // DLQ監視アラーム
    const dlqAlarm = new cloudwatch.Alarm(this, "PaymentDLQAlarm", {
      alarmName: "payment-dlq-messages",
      metric: paymentDlq.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: "Payment DLQ has messages",
    });

    dlqAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    // Lambda Powertools 用の共通環境変数
    const powertoolsEnv = {
      POWERTOOLS_SERVICE_NAME: "dlq-processor",
      POWERTOOLS_METRICS_NAMESPACE: "OrderService",
      LOG_LEVEL: "INFO",
    };

    // DLQ処理Lambda
    const dlqProcessor = new nodejs.NodejsFunction(this, "DLQProcessor", {
      entry: path.join(__dirname, "../lambda/dlq-processor/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        ...powertoolsEnv,
        ORIGINAL_QUEUE_URL: paymentQueue.queueUrl,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ["@aws-sdk/*"],
      },
    });

    // DLQからのイベントソース（手動トリガー用）
    // 自動処理する場合はコメントを外す
    // dlqProcessor.addEventSource(new eventsources.SqsEventSource(paymentDlq, {
    //   batchSize: 1,
    // }));

    paymentQueue.grantSendMessages(dlqProcessor);
    paymentDlq.grantConsumeMessages(dlqProcessor);
  }
}
```

### エラーハンドリング付き Lambda（Lambda Powertools + Zod + Middy）

```typescript
// lambda/payment-processor/index.ts
import { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import middy from "@middy/core";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";
import { logMetrics } from "@aws-lambda-powertools/metrics/middleware";
import { z } from "zod";

const logger = new Logger({ serviceName: "payment-processor" });
const tracer = new Tracer({ serviceName: "payment-processor" });
const metrics = new Metrics({
  serviceName: "payment-processor",
  namespace: "OrderService",
});

// Zod スキーマ
const OrderDetailSchema = z.object({
  orderId: z.string().min(1, "orderId is required"),
  customerId: z.string().min(1, "customerId is required"),
  totalAmount: z.number().nonnegative("totalAmount must be non-negative"),
});

const EventBridgeMessageSchema = z.object({
  detail: OrderDetailSchema,
});

// カスタムエラークラス
class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

const lambdaHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  logger.info("Processing batch", { recordCount: event.Records.length });

  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    const segment = tracer.getSegment();
    const subsegment = segment?.addNewSubsegment("processRecord");

    try {
      await processMessage(record);
      metrics.addMetric("MessageProcessed", MetricUnit.Count, 1);
    } catch (error) {
      if (error instanceof NonRetryableError) {
        // リトライ不要なエラー: ログを残してスキップ
        logger.error("Non-retryable error", {
          messageId: record.messageId,
          error: error.message,
        });
        metrics.addMetric("NonRetryableError", MetricUnit.Count, 1);
        // メッセージを成功として扱い、DLQに行かないようにする
        await logFailedMessage(record, error);
      } else {
        // リトライ可能なエラー: 失敗としてマーク
        logger.error("Retryable error", {
          messageId: record.messageId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        metrics.addMetric("RetryableError", MetricUnit.Count, 1);
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    } finally {
      subsegment?.close();
    }
  }

  return { batchItemFailures };
};

async function processMessage(record: any): Promise<void> {
  // メッセージのバリデーション
  const parseResult = EventBridgeMessageSchema.safeParse(
    JSON.parse(record.body)
  );

  if (!parseResult.success) {
    throw new NonRetryableError(
      `Validation failed: ${parseResult.error.errors[0].message}`
    );
  }

  const detail = parseResult.data.detail;

  tracer.putAnnotation("orderId", detail.orderId);

  logger.info("Processing payment", {
    orderId: detail.orderId,
    amount: detail.totalAmount,
  });

  // 外部API呼び出し（リトライ可能なエラーの可能性）
  try {
    await callPaymentApi(detail);
  } catch (error: any) {
    if (error.code === "NETWORK_ERROR" || error.code === "TIMEOUT") {
      throw new RetryableError(`Payment API error: ${error.message}`);
    }
    throw new NonRetryableError(`Payment rejected: ${error.message}`);
  }
}

async function callPaymentApi(detail: any): Promise<void> {
  // 実際の決済API呼び出し（シミュレーション）
  if (Math.random() < 0.1) {
    const error: any = new Error("Connection timeout");
    error.code = "TIMEOUT";
    throw error;
  }
}

async function logFailedMessage(record: any, error: Error): Promise<void> {
  // 失敗したメッセージをログまたはDBに記録
  logger.warn("Logging failed message for investigation", {
    messageId: record.messageId,
    error: error.message,
    body: record.body,
    timestamp: new Date().toISOString(),
  });
}

export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger, { logEvent: true }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }));
```

### DLQ 処理 Lambda（Lambda Powertools + Zod + Middy）

```typescript
// lambda/dlq-processor/index.ts
import { SQSEvent } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import middy from "@middy/core";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";
import { logMetrics } from "@aws-lambda-powertools/metrics/middleware";
import {
  SQSClient,
  SendMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { z } from "zod";

const logger = new Logger({ serviceName: "dlq-processor" });
const tracer = new Tracer({ serviceName: "dlq-processor" });
const metrics = new Metrics({
  serviceName: "dlq-processor",
  namespace: "OrderService",
});

const sqsClient = tracer.captureAWSv3Client(
  new SQSClient({
    endpoint: process.env.LOCALSTACK_HOSTNAME
      ? `http://${process.env.LOCALSTACK_HOSTNAME}:4566`
      : undefined,
  })
);

const ORIGINAL_QUEUE_URL = process.env.ORIGINAL_QUEUE_URL!;

// Zod スキーマ
const OrderDetailSchema = z.object({
  orderId: z.string().optional(),
  customerId: z.string().optional(),
  totalAmount: z.number().optional(),
});

const DLQMessageSchema = z.object({
  detail: OrderDetailSchema.optional(),
});

interface AnalysisResult {
  canRetry: boolean;
  reason: string;
}

const lambdaHandler = async (event: SQSEvent): Promise<void> => {
  logger.info("Processing DLQ messages", { recordCount: event.Records.length });

  for (const record of event.Records) {
    const segment = tracer.getSegment();
    const subsegment = segment?.addNewSubsegment("processDLQMessage");

    try {
      const message = JSON.parse(record.body);

      logger.info("Analyzing DLQ message", {
        messageId: record.messageId,
        approximateReceiveCount: record.attributes.ApproximateReceiveCount,
      });

      // メッセージの分析
      const analysis = analyzeMessage(message);

      if (analysis.canRetry) {
        // 再処理可能な場合、元のキューに戻す
        await requeueMessage(message);
        metrics.addMetric("MessageRequeued", MetricUnit.Count, 1);
        logger.info("Message requeued", {
          messageId: record.messageId,
          reason: analysis.reason,
        });
      } else {
        // 再処理不可能な場合、アーカイブまたは通知
        await archiveMessage(record, analysis.reason);
        metrics.addMetric("MessageArchived", MetricUnit.Count, 1);
        logger.warn("Message archived", {
          messageId: record.messageId,
          reason: analysis.reason,
        });
      }
    } catch (error) {
      logger.error("Error processing DLQ message", {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      subsegment?.close();
    }
  }
};

function analyzeMessage(message: any): AnalysisResult {
  // Zod でバリデーション
  const parseResult = DLQMessageSchema.safeParse(message);

  if (!parseResult.success) {
    return { canRetry: false, reason: "Invalid message format" };
  }

  const detail = parseResult.data.detail;

  // 必須フィールドのチェック
  if (!detail?.orderId) {
    return { canRetry: false, reason: "Missing orderId" };
  }

  // ビジネスルール違反のチェック
  if (detail.totalAmount !== undefined && detail.totalAmount < 0) {
    return { canRetry: false, reason: "Invalid amount" };
  }

  // その他は再処理可能と判断
  return { canRetry: true, reason: "Temporary failure" };
}

async function requeueMessage(message: any): Promise<void> {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: ORIGINAL_QUEUE_URL,
      MessageBody: JSON.stringify(message),
      DelaySeconds: 60, // 1分後に処理
    })
  );
}

async function archiveMessage(record: any, reason: string): Promise<void> {
  // アーカイブ処理（S3、DynamoDBなど）
  logger.info("Archiving message", {
    messageId: record.messageId,
    reason,
    body: record.body,
    timestamp: new Date().toISOString(),
  });
}

export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger, { logEvent: true }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }));
```

---

## 課題

### 課題 1: DLQ の設定

決済キューに DLQ を設定し、3 回失敗したメッセージが DLQ に移動するようにしてください。

**要件:**

1. DLQ 名: `payment-dlq`
2. 保持期間: 14 日
3. 最大受信回数: 3 回

<details>
<summary>ヒント: DLQの設定</summary>

```typescript
const dlq = new sqs.Queue(this, "DLQ", {
  retentionPeriod: cdk.Duration.days(14),
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
<summary>回答</summary>

```typescript
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
```

</details>

### 課題 2: エラー分類の実装

Lambda 関数内でエラーを分類し、リトライ可能なエラーとそうでないエラーを区別してください。

**要件:**

1. `RetryableError`: ネットワークエラー、タイムアウト
2. `NonRetryableError`: バリデーションエラー、ビジネスルール違反
3. リトライ可能なエラーのみ`batchItemFailures`に追加

<details>
<summary>ヒント: カスタムエラークラス</summary>

```typescript
class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

// 使用例
if (error instanceof RetryableError) {
  // リトライ
}
```

</details>

<details>
<summary>回答</summary>

「コードサンプル」セクションの `payment-processor/index.ts` を参照してください。

</details>

### 課題 3: DLQ 監視アラームの設定

DLQ にメッセージが入ったときにアラートを発生させる CloudWatch アラームを設定してください。

**要件:**

1. DLQ のメッセージ数が 1 以上でアラーム
2. SNS トピックに通知

<details>
<summary>ヒント: CloudWatchアラームの設定</summary>

```typescript
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";

const alarm = new cloudwatch.Alarm(this, "Alarm", {
  metric: queue.metricApproximateNumberOfMessagesVisible(),
  threshold: 1,
  evaluationPeriods: 1,
});
```

</details>

<details>
<summary>回答</summary>

```typescript
const dlqAlarm = new cloudwatch.Alarm(this, "PaymentDLQAlarm", {
  alarmName: "payment-dlq-messages",
  metric: paymentDlq.metricApproximateNumberOfMessagesVisible(),
  threshold: 1,
  evaluationPeriods: 1,
  comparisonOperator:
    cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  alarmDescription: "Payment DLQ has messages",
});

dlqAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));
```

</details>

### 課題 4: 動作確認

意図的にエラーを発生させ、DLQ にメッセージが移動することを確認してください。

```bash
# 不正なメッセージを直接キューに送信
awslocal sqs send-message \
  --queue-url http://sqs.ap-northeast-1.localhost.localstack.cloud:4566/000000000000/payment-queue \
  --message-body '{"invalid": "message"}'

# DLQの確認（3回リトライ後）
awslocal sqs get-queue-attributes \
  --queue-url http://sqs.ap-northeast-1.localhost.localstack.cloud:4566/000000000000/payment-dlq \
  --attribute-names ApproximateNumberOfMessages
```

<details>
<summary>回答: 期待される結果</summary>

```json
{
  "Attributes": {
    "ApproximateNumberOfMessages": "1"
  }
}
```

</details>

---

## エラーハンドリングのベストプラクティス

### 1. べき等性の確保

```typescript
// 同じメッセージを複数回処理しても結果が同じになるように
async function processPayment(orderId: string): Promise<void> {
  // 既に処理済みかチェック
  const existing = await getPaymentByOrderId(orderId);
  if (existing) {
    console.log(`Payment already processed for order: ${orderId}`);
    return;
  }

  // 決済処理
  await createPayment(orderId);
}
```

### 2. 適切なタイムアウト設定

```typescript
// Lambda: 30秒
// 可視性タイムアウト: 60秒（Lambda + バッファ）
// API呼び出し: 10秒
```

### 3. 構造化ログ

```typescript
console.log(
  JSON.stringify({
    level: "ERROR",
    message: "Payment failed",
    orderId: detail.orderId,
    error: error.message,
    timestamp: new Date().toISOString(),
  })
);
```

---

## 確認クイズ

<details>
<summary>Q1: DLQに移動したメッセージはどうなりますか？</summary>

**A1:** DLQ に移動したメッセージは、設定された保持期間（最大 14 日）まで保持されます。その間に手動で調査・再処理するか、自動処理の Lambda を設定して対応します。

</details>

<details>
<summary>Q2: reportBatchItemFailuresの役割は？</summary>

**A2:** バッチ処理で一部のメッセージだけが失敗した場合、失敗したメッセージの ID を返すことで、そのメッセージのみを再処理対象にできます。これにより、成功したメッセージが再処理されることを防ぎます。

</details>

<details>
<summary>Q3: リトライ可能なエラーとそうでないエラーの違いは？</summary>

**A3:**

- **リトライ可能**: 一時的な問題（ネットワークエラー、タイムアウト、サービス一時停止）。時間をおいて再試行すれば成功する可能性がある。
- **リトライ不可能**: 永続的な問題（不正なデータ、ビジネスルール違反）。何度リトライしても失敗する。

</details>

---

## 次のステップ

次のステップでは、イベント駆動システムのテスト戦略を学びます。

[← 通知サービス](./07-notification-service.md) | [テスト戦略 →](./09-testing-strategy.md)
