import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { OpenclawStack } from '../lib/openclaw-stack';
import { resolveRegionConfig } from '../lib/region-config';
import { resolveAgentName } from '../lib/ec2-config';

const agentName = resolveAgentName();
const { region, availabilityZone } = resolveRegionConfig(process.env);

const app = new cdk.App();
new OpenclawStack(app, agentName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  agentName,
  availabilityZone,
  agentInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.LARGE),
  gatewayServerInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.SMALL),
  agentVolumeGb: 30,
});
