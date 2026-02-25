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

type InjectConfig =
  | { type: 'header'; name: string; prefix?: string }
  | { type: 'path' };

const PROVIDER_REGISTRY: Record<string, { envVar: string; inject: InjectConfig }> = {
  // LLM providers
  'api.anthropic.com':                 { envVar: 'ANTHROPIC_API_KEY',  inject: { type: 'header', name: 'x-api-key' } },
  'api.openai.com':                    { envVar: 'OPENAI_API_KEY',     inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' } },
  'generativelanguage.googleapis.com': { envVar: 'GOOGLE_API_KEY',     inject: { type: 'header', name: 'x-goog-api-key' } },
  'api.mistral.ai':                    { envVar: 'MISTRAL_API_KEY',    inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' } },
  'api.groq.com':                      { envVar: 'GROQ_API_KEY',       inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' } },
  'api.x.ai':                          { envVar: 'XAI_API_KEY',        inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' } },
  'openrouter.ai':                     { envVar: 'OPENROUTER_API_KEY', inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' } },
  'api.venice.ai':                     { envVar: 'VENICE_API_KEY',     inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' } },
  'api.cerebras.ai':                   { envVar: 'CEREBRAS_API_KEY',   inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' } },
  // Search
  'api.search.brave.com':              { envVar: 'BRAVE_SEARCH_KEY',   inject: { type: 'header', name: 'X-Subscription-Token' } },
  // Starknet RPC providers (Alchemy, Infura, Blast use API key in URL path -- industry convention)
  'starknet-mainnet.g.alchemy.com':    { envVar: 'ALCHEMY_API_KEY',    inject: { type: 'path' } },
  'starknet-mainnet.infura.io':        { envVar: 'INFURA_API_KEY',     inject: { type: 'path' } },
  'api.cartridge.gg':                  { envVar: 'CARTRIDGE_API_KEY',  inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' } },
  'data.voyager.online':               { envVar: 'VOYAGER_API_KEY',    inject: { type: 'header', name: 'x-apikey' } },
};

export { PROVIDER_REGISTRY, InjectConfig };

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
      description: 'Proxy EC2 role - Secrets Manager read + SSM proxy config read + SSM Session Manager',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // --- Per-Provider Secrets + Proxy Config ---
    const proxyConfig: Record<string, { secretName: string; inject: InjectConfig }> = {};

    for (const [domain, config] of Object.entries(PROVIDER_REGISTRY)) {
      const apiKey = process.env[config.envVar];
      if (!apiKey) continue;

      const secretName = `openclaw/${config.envVar.toLowerCase().replace(/_/g, '-')}`;
      const secret = new secretsmanager.Secret(this, `Secret-${config.envVar}`, {
        secretName,
        description: `API key for ${domain} - only the Proxy EC2 can read this`,
        secretStringValue: cdk.SecretValue.unsafePlainText(apiKey),
      });
      secret.grantRead(proxyRole);

      proxyConfig[domain] = { secretName, inject: config.inject };
    }

    // --- SSM Parameter (Proxy Config) ---
    const proxyConfigParam = new ssm.StringParameter(this, 'ProxyConfig', {
      parameterName: '/openclaw/proxy-config',
      description: 'Proxy provider mapping - domain to secret name and injection method',
      stringValue: JSON.stringify(proxyConfig),
    });
    proxyConfigParam.grantRead(proxyRole);

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

    // --- Docker on Agent ---
    agentInstance.addUserData(
      'dnf update -y',
      'dnf install -y docker',
      'systemctl enable docker',
      'systemctl start docker',
      'usermod -aG docker ec2-user',
    );

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

    new cdk.CfnOutput(this, 'ProxyConfigParameter', {
      value: proxyConfigParam.parameterName,
      description: 'SSM Parameter name for the proxy provider mapping',
    });
  }
}
