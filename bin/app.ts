#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { EdaStack } from "../lib/eda-stack";

const app = new cdk.App();
new EdaStack(app, "EdaStack", {
  env: {
    account: "000000000000",
    region: "ap-northeast-1",
  },
});
