# 通知サービスの実装

## 目標

SNS を使ったファンアウトパターンで、複数の通知チャネル（メール、SMS、プッシュ通知など）に対応した通知サービスを実装します。

---

## 背景情報

### ファンアウトパターンとは

1 つのイベントを複数のサブスクライバーに同時配信するパターンです。

```
                                    ┌─────────────┐
                                    │ Email Lambda│
                                    └─────────────┘
                                          ▲
                                          │
┌─────────────┐     ┌─────────────┐       │
│ EventBridge │────▶│     SNS     │───────┼──────▶ SMS Lambda
│  (イベント)  │     │   (Topic)   │       │
└─────────────┘     └─────────────┘       │
                                          │
                                          ▼
                                    ┌─────────────┐
                                    │ Push Lambda │
                                    └─────────────┘
```

### SNS の主要な特徴

| 特徴               | 説明                                         |
| ------------------ | -------------------------------------------- |
| **Pub/Sub**        | 1 対多のメッセージ配信                       |
| **プロトコル**     | HTTP/S、Email、SMS、Lambda、SQS など         |
| **フィルタリング** | サブスクリプションごとにメッセージをフィルタ |
| **ファンアウト**   | 1 メッセージを複数のエンドポイントに配信     |

### SNS vs SQS

| 特徴               | SNS                | SQS                          |
| ------------------ | ------------------ | ---------------------------- |
| **配信モデル**     | Pub/Sub（1 対多）  | Point-to-Point（1 対 1）     |
| **メッセージ保持** | 保持しない         | 最大 14 日間                 |
| **リトライ**       | 配信ポリシーで設定 | 可視性タイムアウト           |
| **用途**           | 通知、ファンアウト | キューイング、バッファリング |

---

## メリット・デメリット

### SNS を使うメリット

| メリット             | 説明                                       |
| -------------------- | ------------------------------------------ |
| **疎結合**           | パブリッシャーはサブスクライバーを知らない |
| **スケーラビリティ** | サブスクライバーの追加が容易               |
| **多様なプロトコル** | 様々な配信先に対応                         |
| **フィルタリング**   | サブスクライバーごとに受信メッセージを制御 |

### SNS を使うデメリット

| デメリット             | 説明                           |
| ---------------------- | ------------------------------ |
| **メッセージ保持なし** | 配信失敗時のリカバリが困難     |
| **順序保証なし**       | メッセージの順序は保証されない |
| **サイズ制限**         | 最大 256KB                     |

---

## コードサンプル

### SNS トピックの定義（CDK）

```typescript
// lib/constructs/notification-topic.ts
import * as cdk from "aws-cdk-lib";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export class NotificationTopic extends Construct {
  public readonly topic: sns.Topic;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.topic = new sns.Topic(this, "NotificationTopic", {
      topicName: "order-notifications",
      displayName: "Order Notifications",
    });
  }

  addLambdaSubscription(
    fn: lambda.Function,
    filterPolicy?: { [key: string]: sns.SubscriptionFilter }
  ) {
    this.topic.addSubscription(
      new subscriptions.LambdaSubscription(fn, {
        filterPolicy,
      })
    );
  }
}
```

### EventBridge から SNS へのルーティング（CDK）

```typescript
// lib/eda-stack.ts（通知部分）
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import * as path from "path";

// ... 既存のコード ...

// 通知トピック
const notificationTopic = new sns.Topic(this, "NotificationTopic", {
  topicName: "order-notifications",
});

// EventBridgeルール: PaymentCompleted → SNS
const paymentCompletedRule = new events.Rule(
  this,
  "PaymentCompletedToNotification",
  {
    eventBus: eventBus,
    ruleName: "payment-completed-to-notification",
    eventPattern: {
      source: ["payment-service"],
      detailType: ["PaymentCompleted"],
    },
  }
);

paymentCompletedRule.addTarget(new targets.SnsTopic(notificationTopic));

// Lambda Powertools 用の共通環境変数
const emailNotifierEnv = {
  POWERTOOLS_SERVICE_NAME: "email-notifier",
  POWERTOOLS_METRICS_NAMESPACE: "OrderService",
  LOG_LEVEL: "INFO",
};

const smsNotifierEnv = {
  POWERTOOLS_SERVICE_NAME: "sms-notifier",
  POWERTOOLS_METRICS_NAMESPACE: "OrderService",
  LOG_LEVEL: "INFO",
};

// メール通知Lambda
const emailNotifier = new nodejs.NodejsFunction(this, "EmailNotifier", {
  entry: path.join(__dirname, "../lambda/email-notifier/index.ts"),
  handler: "handler",
  runtime: lambda.Runtime.NODEJS_20_X,
  timeout: cdk.Duration.seconds(30),
  memorySize: 256,
  tracing: lambda.Tracing.ACTIVE,
  environment: emailNotifierEnv,
  bundling: {
    minify: true,
    sourceMap: true,
    externalModules: ["@aws-sdk/*"],
  },
});

// SMS通知Lambda
const smsNotifier = new nodejs.NodejsFunction(this, "SmsNotifier", {
  entry: path.join(__dirname, "../lambda/sms-notifier/index.ts"),
  handler: "handler",
  runtime: lambda.Runtime.NODEJS_20_X,
  timeout: cdk.Duration.seconds(30),
  memorySize: 256,
  tracing: lambda.Tracing.ACTIVE,
  environment: smsNotifierEnv,
  bundling: {
    minify: true,
    sourceMap: true,
    externalModules: ["@aws-sdk/*"],
  },
});

// SNSサブスクリプション
notificationTopic.addSubscription(
  new subscriptions.LambdaSubscription(emailNotifier)
);
notificationTopic.addSubscription(
  new subscriptions.LambdaSubscription(smsNotifier)
);
```

### メール通知 Lambda（Lambda Powertools + Zod + Middy）

```typescript
// lambda/email-notifier/index.ts
import { SNSEvent, SNSEventRecord } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import middy from "@middy/core";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";
import { logMetrics } from "@aws-lambda-powertools/metrics/middleware";
import { z } from "zod";

const logger = new Logger({ serviceName: "email-notifier" });
const tracer = new Tracer({ serviceName: "email-notifier" });
const metrics = new Metrics({
  serviceName: "email-notifier",
  namespace: "OrderService",
});

// Zod スキーマ
const PaymentCompletedDetailSchema = z.object({
  orderId: z.string(),
  customerId: z.string(),
  amount: z.number(),
  transactionId: z.string(),
});

const EventBridgeMessageSchema = z.object({
  version: z.string(),
  id: z.string(),
  "detail-type": z.string(),
  source: z.string(),
  detail: PaymentCompletedDetailSchema,
});

type PaymentCompletedDetail = z.infer<typeof PaymentCompletedDetailSchema>;

const lambdaHandler = async (event: SNSEvent): Promise<void> => {
  logger.info("Processing email notifications", {
    recordCount: event.Records.length,
  });

  for (const record of event.Records) {
    await processRecord(record);
  }
};

async function processRecord(record: SNSEventRecord): Promise<void> {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment("processEmailNotification");

  try {
    const parseResult = EventBridgeMessageSchema.safeParse(
      JSON.parse(record.Sns.Message)
    );

    if (!parseResult.success) {
      logger.error("Invalid message format", {
        errors: parseResult.error.errors,
      });
      return;
    }

    const detail = parseResult.data.detail;

    logger.info("Sending email notification", { orderId: detail.orderId });
    tracer.putAnnotation("orderId", detail.orderId);
    subsegment?.addAnnotation("orderId", detail.orderId);

    // 実際のメール送信処理（SESなど）
    const emailContent = {
      to: `customer-${detail.customerId}@example.com`,
      subject: `注文確認: ${detail.orderId}`,
      body: `
        ご注文ありがとうございます。
        
        注文番号: ${detail.orderId}
        お支払い金額: ¥${detail.amount.toLocaleString()}
        取引ID: ${detail.transactionId}
        
        商品の発送準備が整い次第、再度ご連絡いたします。
      `,
    };

    // メール送信をシミュレート
    await sendEmail(emailContent);

    metrics.addMetric("EmailSent", MetricUnit.Count, 1);

    logger.info("Email notification sent", {
      orderId: detail.orderId,
      to: emailContent.to,
    });
  } finally {
    subsegment?.close();
  }
}

interface EmailContent {
  to: string;
  subject: string;
  body: string;
}

async function sendEmail(content: EmailContent): Promise<void> {
  // 実際の実装では SES を使用
  logger.debug("Email content", { content });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger, { logEvent: true }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }));
```

### SMS 通知 Lambda（Lambda Powertools + Zod + Middy）

```typescript
// lambda/sms-notifier/index.ts
import { SNSEvent, SNSEventRecord } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import middy from "@middy/core";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";
import { logMetrics } from "@aws-lambda-powertools/metrics/middleware";
import { z } from "zod";

const logger = new Logger({ serviceName: "sms-notifier" });
const tracer = new Tracer({ serviceName: "sms-notifier" });
const metrics = new Metrics({
  serviceName: "sms-notifier",
  namespace: "OrderService",
});

// Zod スキーマ
const PaymentCompletedDetailSchema = z.object({
  orderId: z.string(),
  customerId: z.string(),
  amount: z.number(),
  transactionId: z.string(),
});

const EventBridgeMessageSchema = z.object({
  version: z.string(),
  id: z.string(),
  "detail-type": z.string(),
  source: z.string(),
  detail: PaymentCompletedDetailSchema,
});

type PaymentCompletedDetail = z.infer<typeof PaymentCompletedDetailSchema>;

const lambdaHandler = async (event: SNSEvent): Promise<void> => {
  logger.info("Processing SMS notifications", {
    recordCount: event.Records.length,
  });

  for (const record of event.Records) {
    await processRecord(record);
  }
};

async function processRecord(record: SNSEventRecord): Promise<void> {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment("processSmsNotification");

  try {
    const parseResult = EventBridgeMessageSchema.safeParse(
      JSON.parse(record.Sns.Message)
    );

    if (!parseResult.success) {
      logger.error("Invalid message format", {
        errors: parseResult.error.errors,
      });
      return;
    }

    const detail = parseResult.data.detail;

    logger.info("Sending SMS notification", { orderId: detail.orderId });
    tracer.putAnnotation("orderId", detail.orderId);
    subsegment?.addAnnotation("orderId", detail.orderId);

    // 実際のSMS送信処理（SNS SMS、Twilioなど）
    const smsContent = {
      phoneNumber: "+81XXXXXXXXXX", // 実際は顧客情報から取得
      message: `【注文確認】注文番号${
        detail.orderId
      }のお支払い(¥${detail.amount.toLocaleString()})が完了しました。`,
    };

    // SMS送信をシミュレート
    await sendSms(smsContent);

    metrics.addMetric("SmsSent", MetricUnit.Count, 1);

    logger.info("SMS notification sent", {
      orderId: detail.orderId,
      phoneNumber: smsContent.phoneNumber,
    });
  } finally {
    subsegment?.close();
  }
}

interface SmsContent {
  phoneNumber: string;
  message: string;
}

async function sendSms(content: SmsContent): Promise<void> {
  // 実際の実装では SNS SMS や Twilio を使用
  logger.debug("SMS content", { content });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

export const handler = middy(lambdaHandler)
  .use(injectLambdaContext(logger, { logEvent: true }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }));
```

### サブスクリプションフィルタの例

```typescript
// 高額注文のみメール通知
notificationTopic.addSubscription(
  new subscriptions.LambdaSubscription(emailNotifier, {
    filterPolicy: {
      amount: sns.SubscriptionFilter.numericFilter({
        greaterThanOrEqualTo: 10000,
      }),
    },
  })
);

// VIP顧客のみSMS通知
notificationTopic.addSubscription(
  new subscriptions.LambdaSubscription(smsNotifier, {
    filterPolicy: {
      customerId: sns.SubscriptionFilter.stringFilter({
        allowlist: ["VIP-001", "VIP-002"],
      }),
    },
  })
);
```

---

## 課題

### 課題 1: SNS トピックの作成

CDK を使用して、注文通知用の SNS トピックを作成してください。

**要件:**

1. トピック名: `order-notifications`
2. 表示名: `Order Notifications`

<details>
<summary>ヒント: SNSトピックの作成</summary>

```typescript
import * as sns from "aws-cdk-lib/aws-sns";

new sns.Topic(this, "Topic", {
  topicName: "topic-name",
  displayName: "Display Name",
});
```

</details>

<details>
<summary>回答</summary>

```typescript
const notificationTopic = new sns.Topic(this, "NotificationTopic", {
  topicName: "order-notifications",
  displayName: "Order Notifications",
});
```

確認コマンド:

```bash
npx cdklocal deploy
awslocal sns list-topics
```

</details>

### 課題 2: EventBridge から SNS へのルーティング

`PaymentCompleted`イベントを通知トピックにルーティングする EventBridge ルールを作成してください。

**要件:**

1. `payment-service`からの`PaymentCompleted`イベントをマッチ
2. ターゲットとして`order-notifications`トピックを設定

<details>
<summary>ヒント: SNSターゲットの設定</summary>

```typescript
import * as targets from "aws-cdk-lib/aws-events-targets";

rule.addTarget(new targets.SnsTopic(topic));
```

</details>

<details>
<summary>回答</summary>

```typescript
const paymentCompletedRule = new events.Rule(
  this,
  "PaymentCompletedToNotification",
  {
    eventBus: eventBus,
    ruleName: "payment-completed-to-notification",
    eventPattern: {
      source: ["payment-service"],
      detailType: ["PaymentCompleted"],
    },
  }
);

paymentCompletedRule.addTarget(new targets.SnsTopic(notificationTopic));
```

</details>

### 課題 3: 通知 Lambda の実装とサブスクリプション

メール通知用の Lambda 関数を実装し、SNS トピックにサブスクライブしてください。

**要件:**

1. SNS イベントから PaymentCompleted イベントを取得
2. 注文情報をログに出力（メール送信のシミュレーション）
3. SNS トピックに Lambda をサブスクライブ

<details>
<summary>ヒント 1: SNSイベントの構造</summary>

```typescript
import { SNSEvent } from "aws-lambda";

// SNSメッセージのMessageにEventBridgeイベントが含まれる
const message = JSON.parse(record.Sns.Message);
const detail = message.detail;
```

</details>

<details>
<summary>ヒント 2: Lambdaサブスクリプション</summary>

```typescript
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";

topic.addSubscription(new subscriptions.LambdaSubscription(fn));
```

</details>

<details>
<summary>回答</summary>

Lambda 関数は「コードサンプル」セクションの `email-notifier/index.ts` を参照してください。

CDK でのサブスクリプション:

```typescript
notificationTopic.addSubscription(
  new subscriptions.LambdaSubscription(emailNotifier)
);
```

</details>

### 課題 4: 動作確認

デプロイ後、注文を作成して通知が送信されることを確認してください。

```bash
# デプロイ
npx cdklocal deploy

# 注文作成（決済完了まで自動で進む）
curl -X POST http://localhost:4566/restapis/<api-id>/prod/_user_request_/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "CUST-001",
    "items": [{"productId": "PROD-A", "quantity": 1, "price": 1000}]
  }'

# 通知Lambdaのログ確認
awslocal logs filter-log-events \
  --log-group-name "/aws/lambda/EdaStack-EmailNotifier..." \
  --filter-pattern "Email notification"
```

<details>
<summary>回答: 期待されるログ</summary>

```
Sending email notification for order: ORD-XXXXXXXX
Email content: {
  to: 'customer-CUST-001@example.com',
  subject: '注文確認: ORD-XXXXXXXX',
  body: '...'
}
Email notification sent for order: ORD-XXXXXXXX
```

</details>

---

## SNS + SQS のファンアウトパターン

より堅牢な構成として、SNS と SQS を組み合わせることができます。

```
                                    ┌─────────────┐     ┌─────────────┐
                                    │  Email SQS  │────▶│ Email Lambda│
                                    └─────────────┘     └─────────────┘
                                          ▲
                                          │
┌─────────────┐     ┌─────────────┐       │
│ EventBridge │────▶│     SNS     │───────┤
│  (イベント)  │     │   (Topic)   │       │
└─────────────┘     └─────────────┘       │
                                          │
                                          ▼
                                    ┌─────────────┐     ┌─────────────┐
                                    │   SMS SQS   │────▶│  SMS Lambda │
                                    └─────────────┘     └─────────────┘
```

**メリット:**

- SQS がバッファとして機能
- 失敗時のリトライと DLQ が使える
- 各チャネルを独立してスケール可能

```typescript
// SNS → SQS → Lambda の構成
const emailQueue = new sqs.Queue(this, "EmailQueue");
const smsQueue = new sqs.Queue(this, "SmsQueue");

notificationTopic.addSubscription(
  new subscriptions.SqsSubscription(emailQueue)
);
notificationTopic.addSubscription(new subscriptions.SqsSubscription(smsQueue));

emailNotifier.addEventSource(new eventsources.SqsEventSource(emailQueue));
smsNotifier.addEventSource(new eventsources.SqsEventSource(smsQueue));
```

---

## 確認クイズ

<details>
<summary>Q1: SNSのファンアウトパターンとは何ですか？</summary>

**A1:** 1 つのメッセージを複数のサブスクライバーに同時配信するパターンです。SNS トピックに複数のサブスクリプション（Lambda、SQS、HTTP など）を設定することで実現します。

</details>

<details>
<summary>Q2: SNSサブスクリプションフィルタの用途は？</summary>

**A2:** サブスクライバーごとに受信するメッセージを制御できます。例えば、高額注文のみメール通知、VIP 顧客のみ SMS 通知といった条件分岐が可能です。

</details>

<details>
<summary>Q3: SNS + SQSの組み合わせのメリットは？</summary>

**A3:**

1. SQS がバッファとして機能し、スパイクを吸収
2. 失敗時のリトライと DLQ が使える
3. 各サブスクライバーを独立してスケール可能
4. メッセージの永続化（SNS 単体では保持されない）

</details>

---

## 次のステップ

次のステップでは、エラーハンドリングと Dead Letter Queue の実装を学びます。

[← 決済サービス](./06-payment-service.md) | [エラーハンドリング →](./08-error-handling.md)
