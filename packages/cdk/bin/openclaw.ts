#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { OpenclawStack } from '../lib/openclaw-stack';
import { AgentOsFamily } from '../lib/agent-machine-config';

const app = new cdk.App();
new OpenclawStack(app, 'OpenclawStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  agentMachine: {
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.LARGE),
    osFamily: AgentOsFamily.UBUNTU_24_04,
  },
});
