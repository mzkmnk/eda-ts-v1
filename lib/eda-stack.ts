import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as events from "aws-cdk-lib/aws-events";

export class EdaStack extends cdk.Stack {
  public readonly eventBus: events.EventBus;
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.eventBus = new events.EventBus(this, "orderEventsBus", {
      eventBusName: "order-events"
    })

    new cdk.CfnOutput(this, "EventBusArn",  {
      value: this.eventBus.eventBusArn,
      description: "Order Event Bus Arn"
    })
  }
}
