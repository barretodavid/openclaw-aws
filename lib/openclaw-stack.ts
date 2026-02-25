import * as dotenv from 'dotenv';
dotenv.config();

import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

const PROXY_PORT = 8080;

export class OpenclawStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- KMS Key (Wallet) ---
    const walletKey = new kms.Key(this, 'WalletKey', {
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      alias: 'openclaw-wallet-key',
      description: 'Starknet secp256r1 signing key - private key never leaves HSM',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Secrets Manager (LLM API Key) ---
    const llmApiKeySecret = new secretsmanager.Secret(this, 'LlmApiKey', {
      secretName: 'openclaw/llm-api-key',
      description: 'LLM provider API key - only the Proxy EC2 can read this',
      secretStringValue: cdk.SecretValue.unsafePlainText(
        process.env.LLM_API_KEY || 'REPLACE_ME',
      ),
    });

    // --- SSM Parameter (Allowed LLM Providers) ---
    const allowedLlmProviders = new ssm.StringListParameter(this, 'AllowedLlmProviders', {
      parameterName: '/openclaw/allowed-llm-providers',
      description: 'Allowed LLM provider domains - proxy only forwards to these hosts',
      stringListValue: [
        'api.openai.com',
        'api.anthropic.com',
        'generativelanguage.googleapis.com',
        'api.mistral.ai',
        'api.groq.com',
        'api.x.ai',
        'openrouter.ai',
        'api.venice.ai',
        'api.cerebras.ai',
      ],
    });

    // --- Default VPC ---
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // --- Security Groups ---
    const agentSg = new ec2.SecurityGroup(this, 'AgentSg', {
      vpc,
      description: 'Agent EC2 - no inbound, outbound HTTPS broadly',
      allowAllOutbound: false,
    });
    agentSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Outbound HTTPS');

    const proxySg = new ec2.SecurityGroup(this, 'ProxySg', {
      vpc,
      description: 'Proxy EC2 - inbound from Agent on proxy port, outbound HTTPS',
      allowAllOutbound: false,
    });
    proxySg.addIngressRule(agentSg, ec2.Port.tcp(PROXY_PORT), 'Agent to Proxy');
    proxySg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Outbound HTTPS to LLM provider');

    // Agent also needs to reach the proxy
    agentSg.addEgressRule(proxySg, ec2.Port.tcp(PROXY_PORT), 'Agent to Proxy');

    // --- IAM Roles ---
    const agentRole = new iam.Role(this, 'AgentRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Agent EC2 role - KMS Sign + SSM Session Manager',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    walletKey.grant(agentRole, 'kms:Sign');

    const proxyRole = new iam.Role(this, 'ProxyRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Proxy EC2 role - Secrets Manager read + SSM allowed providers read + SSM Session Manager',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    llmApiKeySecret.grantRead(proxyRole);
    allowedLlmProviders.grantRead(proxyRole);

    // --- EC2 Instances ---
    const amazonLinux2023Arm = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    });

    const agentInstance = new ec2.Instance(this, 'AgentInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.LARGE),
      machineImage: amazonLinux2023Arm,
      securityGroup: agentSg,
      role: agentRole,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, { volumeType: ec2.EbsDeviceVolumeType.GP3 }),
        },
      ],
      requireImdsv2: true,
    });

    const proxyInstance = new ec2.Instance(this, 'ProxyInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: amazonLinux2023Arm,
      securityGroup: proxySg,
      role: proxyRole,
      requireImdsv2: true,
    });

    // --- Stack Outputs ---
    new cdk.CfnOutput(this, 'AgentInstanceId', {
      value: agentInstance.instanceId,
      description: 'Agent EC2 instance ID - use with: aws ssm start-session --target <id>',
    });

    new cdk.CfnOutput(this, 'ProxyInstanceId', {
      value: proxyInstance.instanceId,
      description: 'Proxy EC2 instance ID - use with: aws ssm start-session --target <id>',
    });

    new cdk.CfnOutput(this, 'ProxyPrivateIp', {
      value: proxyInstance.instancePrivateIp,
      description: 'Proxy private IP - configure agent LLM endpoint as http://<ip>:8080',
    });

    new cdk.CfnOutput(this, 'WalletKeyArn', {
      value: walletKey.keyArn,
      description: 'KMS wallet key ARN - use for kms:Sign calls',
    });

    new cdk.CfnOutput(this, 'LlmApiKeySecretArn', {
      value: llmApiKeySecret.secretArn,
      description: 'Secrets Manager ARN for the LLM API key',
    });

    new cdk.CfnOutput(this, 'AllowedLlmProvidersParameter', {
      value: allowedLlmProviders.parameterName,
      description: 'SSM Parameter name for the allowed LLM provider domains',
    });
  }
}
