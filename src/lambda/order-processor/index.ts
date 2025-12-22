import { EventBridgeEvent } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { MetricUnit, Metrics } from "@aws-lambda-powertools/metrics";
import { z } from "zod";
import middy from "@middy/core";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";
import { logMetrics } from "@aws-lambda-powertools/metrics/middleware";
import { trace } from "console";

const OrderDetailSchema = z.object({
  orderId: z.string().min(1),
  customerId: z.string().min(1),
  totalAmount: z.number().nonnegative(),
});

type OrderDetail = z.infer<typeof OrderDetailSchema>;

const logger = new Logger({ serviceName: "order-processor" });
const tracer = new Tracer({ serviceName: "order-processor" });
const metrics = new Metrics({
  serviceName: "order-processor",
  namespace: "OrderService",
});

const lambdaHandlder = async (
  event: EventBridgeEvent<"OrderCreated", OrderDetail>
) => {
  const parseResult = OrderDetailSchema.safeParse(event.detail);

  if (!parseResult.success) {
    logger.error("Invalid event detail", {
      errors: parseResult.error.issues,
    });
    throw new Error(`Validation failed: ${parseResult.error.message}`);
  }

  const { orderId, customerId, totalAmount } = parseResult.data;

  tracer.putAnnotation("orderId", orderId);
  tracer.putAnnotation("customerId", customerId);

  logger.info("order details", {
    eventId: event.id,
    source: event.source,
    detailType: event["detail-type"],
    orderId,
    customerId,
    totalAmount,
  });

  metrics.addMetric("OrderProcessed", MetricUnit.Count, 1);
  metrics.addMetadata("orderId", orderId);

  logger.info("Processing completed", { orderId });

  return {
    statusCode: 200,
    body: JSON.stringify({ message: `Order ${orderId} processed` }),
  };
};

export const handler = middy(lambdaHandlder)
  .use(injectLambdaContext(logger, { logEvent: true }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }));
