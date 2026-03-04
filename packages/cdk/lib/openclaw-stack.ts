import * as dotenv from 'dotenv';
import * as path from 'node:path';
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { resolveAgentMachine, PROVIDER_REGISTRY, InjectConfig, ubuntuBaseUserData } from './ec2-config';

const PROXY_PORT = 8080;

export interface OpenclawStackProps extends cdk.StackProps {
  /** Agent EC2 instance type. Must be x86_64. */
  readonly agentInstanceType: ec2.InstanceType;
  /** Proxy EC2 instance type. Must be x86_64. */
  readonly proxyInstanceType: ec2.InstanceType;
  /** Availability zone for both EC2 instances. */
  readonly availabilityZone: string;
  /** Root EBS volume size (GB) for the agent instance. */
  readonly agentVolumeGb: number;
}

export class OpenclawStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OpenclawStackProps) {
    super(scope, id, props);

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
      description: 'Agent EC2 role - KMS wallet management + SSM Session Manager',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Create wallet keys -- only ECC_NIST_P256 SIGN_VERIFY with the openclaw:wallet tag
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:CreateKey'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:RequestTag/openclaw': 'wallet',
          'kms:KeySpec': 'ECC_NIST_P256',
          'kms:KeyUsage': 'SIGN_VERIFY',
        },
      },
    }));

    // Tag wallet keys (required by CreateKey when tags are specified).
    // No aws:RequestTag condition here -- KMS does not propagate request
    // tags to the implicit kms:TagResource authorization during CreateKey.
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:TagResource'],
      resources: ['*'],
    }));

    // Use wallet-tagged keys (sign, get public key, describe)
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Sign', 'kms:GetPublicKey', 'kms:DescribeKey'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'aws:ResourceTag/openclaw': 'wallet',
        },
      },
    }));

    // Discover wallet keys via Resource Groups Tagging API
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['tag:GetResources'],
      resources: ['*'],
    }));

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

    const agentMachine = resolveAgentMachine(props.agentInstanceType);

    const agentInstance = new ec2.Instance(this, 'AgentInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC, availabilityZones: [props.availabilityZone] },
      instanceType: props.agentInstanceType,
      machineImage: agentMachine.machineImage,
      securityGroup: agentSg,
      role: agentRole,
      blockDevices: [
        {
          deviceName: agentMachine.rootDeviceName,
          volume: ec2.BlockDeviceVolume.ebs(props.agentVolumeGb, { volumeType: ec2.EbsDeviceVolumeType.GP3 }),
        },
      ],
      requireImdsv2: true,
    });

    // --- Docker + Node.js on Agent ---
    agentInstance.addUserData(
      ...agentMachine.userDataCommands,
      `usermod -aG docker ${agentMachine.defaultUser}`,
    );

    const proxyMachine = resolveAgentMachine(props.proxyInstanceType);

    const proxyInstance = new ec2.Instance(this, 'ProxyInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC, availabilityZones: [props.availabilityZone] },
      instanceType: props.proxyInstanceType,
      machineImage: proxyMachine.machineImage,
      securityGroup: proxySg,
      role: proxyRole,
      requireImdsv2: true,
    });

    // --- Proxy Application (installed from npm) ---
    proxyInstance.addUserData(
      ...ubuntuBaseUserData(),
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

    new cdk.CfnOutput(this, 'ProxyConfigParameter', {
      value: proxyConfigParam.parameterName,
      description: 'SSM Parameter name for the proxy provider mapping',
    });
  }
}
