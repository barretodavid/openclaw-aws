import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { OpenclawStack } from '../lib/openclaw-stack';

const app = new cdk.App();
new OpenclawStack(app, 'OpenclawStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  availabilityZone: process.env.CDK_AVAILABILITY_ZONE ?? 'ca-central-1b',
  agentInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.LARGE),
  proxyInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.NANO),
  gatewayInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.NANO),
  agentVolumeGb: 30,
});
