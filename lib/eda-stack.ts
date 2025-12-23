import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";
import path from "path";

const __dirname = import.meta.dirname;

export class EdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const eventBus = new events.EventBus(this, "orderEventsBus", {
      eventBusName: "order-events",
    });

    const orderProcessorLambdaDLQ = new sqs.Queue(
      this,
      "OrderProcessorLambdaDLQ",
      {
        queueName: "order-processor-lambda-dlq",
        retentionPeriod: cdk.Duration.days(14),
      }
    );

    const orderProcessor = new nodejs.NodejsFunction(this, "OrderProcesser", {
      entry: path.join(__dirname, "../src/lambda/order-processor/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      deadLetterQueue: orderProcessorLambdaDLQ,
      retryAttempts: 2,
      environment: {
        POWERTOOLS_SERVICE_NAME: "order-processor",
        POWERTOOLS_METRICS_NAMESPACE: "OrderService",
        LOG_LEVEL: "INFO",
        EVENT_BUS_NAME: eventBus.eventBusName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ["@aws-sdk/*"],
      },
    });

    const orderCreatedRule = new events.Rule(this, "OrderCreatedRule", {
      eventBus: eventBus,
      ruleName: "order-created-rule",
      eventPattern: {
        source: ["order-service"],
        detailType: ["OrderCreated"],
      },
    });

    const orderProcessorEventDLQ = new sqs.Queue(this, "OrderProcessorDLQ", {
      queueName: "order-processor-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    orderCreatedRule.addTarget(
      new targets.LambdaFunction(orderProcessor, {
        deadLetterQueue: orderProcessorEventDLQ,
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(1),
      })
    );
  }
}
