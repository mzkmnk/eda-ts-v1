import { EventBridgeEvent } from "aws-lambda";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { MetricUnit, Metrics } from "@aws-lambda-powertools/metrics";
import { z } from "zod";
import middy from "@middy/core";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";
import { logMetrics } from "@aws-lambda-powertools/metrics/middleware";

const OrderDetailSchema = z.object({
  orderId: z.string().min(1),
  customerId: z.string().min(1),
  totalAmount: z.number().nonnegative(),
});

type OrderDetail = z.infer<typeof OrderDetailSchema>;

const logger = new Logger();
const tracer = new Tracer();
const metrics = new Metrics();

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

  logger.info("Order details", {
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
};

export const handler = middy(lambdaHandlder)
  .use(injectLambdaContext(logger, { logEvent: true }))
  .use(captureLambdaHandler(tracer))
  .use(logMetrics(metrics, { captureColdStartMetric: true }));
