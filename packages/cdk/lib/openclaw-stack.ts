import * as dotenv from 'dotenv';
import * as path from 'node:path';
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { AgentMachineConfig, AgentOsFamily, resolveAgentMachine } from './agent-machine-config';

const PROXY_PORT = 8080;
const AVAILABILITY_ZONE = 'ca-central-1b';

type InjectConfig =
  | { type: 'header'; name: string; prefix?: string }
  | { type: 'path' };

// api: matches OpenClaw's --custom-compatibility flag (anthropic | openai | null for non-LLM services)
type ProviderConfig = { envVar: string; inject: InjectConfig; subdomain: string; api: string | null };

const PROVIDER_REGISTRY: Record<string, ProviderConfig> = {
  // LLM providers
  'api.anthropic.com':                 { envVar: 'ANTHROPIC_API_KEY',  inject: { type: 'header', name: 'x-api-key' },                          subdomain: 'anthropic',  api: 'anthropic' },
  'api.openai.com':                    { envVar: 'OPENAI_API_KEY',     inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'openai',     api: 'openai' },
  'generativelanguage.googleapis.com': { envVar: 'GOOGLE_API_KEY',     inject: { type: 'header', name: 'x-goog-api-key' },                    subdomain: 'google',     api: 'openai' },
  'api.mistral.ai':                    { envVar: 'MISTRAL_API_KEY',    inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'mistral',    api: 'openai' },
  'api.groq.com':                      { envVar: 'GROQ_API_KEY',       inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'groq',       api: 'openai' },
  'api.x.ai':                          { envVar: 'XAI_API_KEY',        inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'xai',        api: 'openai' },
  'openrouter.ai':                     { envVar: 'OPENROUTER_API_KEY', inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'openrouter', api: 'openai' },
  'api.venice.ai':                     { envVar: 'VENICE_API_KEY',     inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'venice',     api: 'openai' },
  'api.cerebras.ai':                   { envVar: 'CEREBRAS_API_KEY',   inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'cerebras',   api: 'openai' },
  // Search
  'api.search.brave.com':              { envVar: 'BRAVE_SEARCH_KEY',   inject: { type: 'header', name: 'X-Subscription-Token' },               subdomain: 'brave',      api: null },
  // Starknet RPC providers (Alchemy, Infura use API key in URL path -- industry convention)
  'starknet-mainnet.g.alchemy.com':    { envVar: 'ALCHEMY_API_KEY',    inject: { type: 'path' },                                               subdomain: 'alchemy',    api: null },
  'starknet-mainnet.infura.io':        { envVar: 'INFURA_API_KEY',     inject: { type: 'path' },                                               subdomain: 'infura',     api: null },
  'api.cartridge.gg':                  { envVar: 'CARTRIDGE_API_KEY',  inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },   subdomain: 'cartridge',  api: null },
  'data.voyager.online':               { envVar: 'VOYAGER_API_KEY',    inject: { type: 'header', name: 'x-apikey' },                           subdomain: 'voyager',    api: null },
};

export { PROVIDER_REGISTRY, InjectConfig, ProviderConfig };

export interface OpenclawStackProps extends cdk.StackProps {
  /**
   * Agent EC2 machine configuration.
   * Controls instance type and operating system.
   * @default - t4g.large with Amazon Linux 2023
   */
  readonly agentMachine?: AgentMachineConfig;
}

export class OpenclawStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: OpenclawStackProps) {
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
    agentSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Outbound HTTP (apt/package repos)');

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
    const proxyConfig: Record<string, { backendDomain: string; secretName: string; inject: InjectConfig; api: string | null }> = {};

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

      proxyConfig[config.subdomain] = { backendDomain: domain, secretName, inject: config.inject, api: config.api };
    }

    // --- SSM Parameter (Proxy Config) ---
    const proxyConfigParam = new ssm.StringParameter(this, 'ProxyConfig', {
      parameterName: '/openclaw/proxy-config',
      description: 'Proxy provider mapping - domain to secret name and injection method',
      stringValue: JSON.stringify(proxyConfig),
    });
    proxyConfigParam.grantRead(proxyRole);

    // --- EC2 Instances ---

    // Resolve agent machine config (instance type, OS, user data)
    const agentInstanceType = props?.agentMachine?.instanceType
      ?? ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.LARGE);
    const agentOsFamily = props?.agentMachine?.osFamily ?? AgentOsFamily.AMAZON_LINUX_2023;
    const cpuType = agentInstanceType.architecture === ec2.InstanceArchitecture.ARM_64
      ? ec2.AmazonLinuxCpuType.ARM_64
      : ec2.AmazonLinuxCpuType.X86_64;
    const agentMachine = resolveAgentMachine(agentOsFamily, cpuType);

    const agentInstance = new ec2.Instance(this, 'AgentInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC, availabilityZones: [AVAILABILITY_ZONE] },
      instanceType: agentInstanceType,
      machineImage: agentMachine.machineImage,
      securityGroup: agentSg,
      role: agentRole,
      blockDevices: [
        {
          deviceName: agentMachine.rootDeviceName,
          volume: ec2.BlockDeviceVolume.ebs(30, { volumeType: ec2.EbsDeviceVolumeType.GP3 }),
        },
      ],
      requireImdsv2: true,
    });

    // --- Docker + Node.js on Agent ---
    agentInstance.addUserData(
      ...agentMachine.userDataCommands,
      `usermod -aG docker ${agentMachine.defaultUser}`,
    );

    const amazonLinux2023Arm = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    });

    const proxyInstance = new ec2.Instance(this, 'ProxyInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC, availabilityZones: [AVAILABILITY_ZONE] },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: amazonLinux2023Arm,
      securityGroup: proxySg,
      role: proxyRole,
      requireImdsv2: true,
    });

    // --- Proxy Application (installed from npm) ---
    proxyInstance.addUserData(
      // Install Node.js 22 LTS via NodeSource
      'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
      'dnf install -y nodejs',
      // Install proxy from npm (global)
      'npm install -g openclaw-aws-proxy',
      // Create systemd service
      [
        'cat > /etc/systemd/system/openclaw-proxy.service << EOF',
        '[Unit]',
        'Description=OpenClaw LLM Proxy',
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart=/usr/bin/openclaw-aws-proxy',
        'Restart=on-failure',
        'RestartSec=5',
        'Environment=NODE_ENV=production',
        `Environment=AWS_REGION=${this.region}`,
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        'EOF',
      ].join('\n'),
      'systemctl daemon-reload',
      'systemctl enable openclaw-proxy',
      'systemctl start openclaw-proxy',
    );

    // --- Private DNS (proxy.vpc) ---
    const hostedZone = new route53.PrivateHostedZone(this, 'InternalZone', {
      zoneName: 'vpc',
      vpc,
    });

    new route53.ARecord(this, 'ProxyDns', {
      zone: hostedZone,
      recordName: 'proxy',
      target: route53.RecordTarget.fromIpAddresses(proxyInstance.instancePrivateIp),
    });

    // Per-provider subdomains (only for configured providers)
    for (const [, config] of Object.entries(PROVIDER_REGISTRY)) {
      if (!process.env[config.envVar]) continue;

      new route53.ARecord(this, `Dns-${config.subdomain}`, {
        zone: hostedZone,
        recordName: `${config.subdomain}.proxy`,
        target: route53.RecordTarget.fromIpAddresses(proxyInstance.instancePrivateIp),
      });
    }

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
      description: 'Proxy address: http://proxy.vpc:8080',
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
