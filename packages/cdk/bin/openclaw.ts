import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { OpenclawStack } from '../lib/openclaw-stack';
import { resolveRegionConfig } from '../lib/region-config';

const { region, availabilityZone } = resolveRegionConfig(process.env);

const app = new cdk.App();
new OpenclawStack(app, 'OpenclawStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  availabilityZone,
  agentInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.LARGE),
  proxyInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.MICRO),
  gatewayInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.SMALL),
  agentVolumeGb: 30,
});
