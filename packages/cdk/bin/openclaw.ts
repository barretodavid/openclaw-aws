import * as cdk from 'aws-cdk-lib/core';
import { OpenclawStack } from '../lib/openclaw-stack';
import { config } from '../config';

const app = new cdk.App();
new OpenclawStack(app, 'OpenclawStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  agentInstanceType: config.agentInstanceType,
  proxyInstanceType: config.proxyInstanceType,
  availabilityZone: config.availabilityZone,
  agentVolumeGb: config.agentVolumeGb,
});
