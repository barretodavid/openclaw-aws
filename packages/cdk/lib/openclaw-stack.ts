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
import { resolveAgentMachine, PROVIDER_REGISTRY, InjectConfig, ubuntuBaseUserData, requireBraveApiKey, requireAtLeastOneLlmProvider } from './ec2-config';

const PROXY_PORT = 8080;
const GATEWAY_PORT = 18789;

export interface OpenclawStackProps extends cdk.StackProps {
  /** Agent Server EC2 instance type. Must be x86_64. */
  readonly agentInstanceType: ec2.InstanceType;
  /** Proxy Server EC2 instance type. Must be x86_64. */
  readonly proxyServerInstanceType: ec2.InstanceType;
  /** Gateway Server EC2 instance type. Must be x86_64. */
  readonly gatewayServerInstanceType: ec2.InstanceType;
  /** Availability zone for all EC2 instances. */
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
      description: 'Agent Server EC2 - no inbound, outbound HTTPS broadly',
      allowAllOutbound: false,
    });
    agentSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Outbound HTTPS');
    agentSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Outbound HTTP (apt/package repos)');

    const proxyServerSg = new ec2.SecurityGroup(this, 'ProxyServerSg', {
      vpc,
      description: 'Proxy Server EC2 - inbound from Agent on proxy port, outbound HTTPS and HTTP',
      allowAllOutbound: false,
    });
    proxyServerSg.addIngressRule(agentSg, ec2.Port.tcp(PROXY_PORT), 'Agent to Proxy Server');
    proxyServerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Outbound HTTPS to LLM provider');
    proxyServerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Outbound HTTP (apt/package repos)');

    const gatewayServerSg = new ec2.SecurityGroup(this, 'GatewayServerSg', {
      vpc,
      description: 'Gateway Server EC2 - inbound WebSocket from Agent, outbound HTTPS for channel APIs',
      allowAllOutbound: false,
    });
    gatewayServerSg.addIngressRule(agentSg, ec2.Port.tcp(GATEWAY_PORT), 'Agent to Gateway Server WebSocket');
    gatewayServerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Outbound HTTPS (channel APIs)');
    gatewayServerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Outbound HTTP (apt/package repos)');

    // Agent also needs to reach the proxy server and gateway server
    agentSg.addEgressRule(proxyServerSg, ec2.Port.tcp(PROXY_PORT), 'Agent to Proxy Server');
    agentSg.addEgressRule(gatewayServerSg, ec2.Port.tcp(GATEWAY_PORT), 'Agent to Gateway Server WebSocket');

    // --- IAM Roles ---
    const agentRole = new iam.Role(this, 'AgentRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Agent Server EC2 role - KMS wallet management + SSM Session Manager',
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

    const gatewayServerRole = new iam.Role(this, 'GatewayServerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Gateway Server EC2 role - SSM Session Manager only (no KMS, no Secrets Manager)',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const proxyServerRole = new iam.Role(this, 'ProxyServerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Proxy Server EC2 role - Secrets Manager read + SSM proxy config read + SSM Session Manager',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // --- Validate Required Keys ---
    requireAtLeastOneLlmProvider();

    // --- Per-Provider Secrets + Proxy Server Config ---
    const proxyServerConfig: Record<string, { backendDomain: string; secretName: string; inject: InjectConfig; api: string | null }> = {};

    for (const [domain, config] of Object.entries(PROVIDER_REGISTRY)) {
      const apiKey = process.env[config.envVar];
      if (!apiKey) continue;

      const secretName = `openclaw/${config.envVar.toLowerCase().replace(/_/g, '-')}`;
      const secret = new secretsmanager.Secret(this, `Secret-${config.envVar}`, {
        secretName,
        description: `API key for ${domain} - only the Proxy Server EC2 can read this`,
        secretStringValue: cdk.SecretValue.unsafePlainText(apiKey),
      });
      secret.grantRead(proxyServerRole);

      proxyServerConfig[config.subdomain] = { backendDomain: domain, secretName, inject: config.inject, api: config.api };
    }

    // --- Brave Search Secret (Agent Server only) ---
    const braveApiKey = requireBraveApiKey();
    const braveSecret = new secretsmanager.Secret(this, 'BraveApiKeySecret', {
      secretName: 'openclaw/brave-api-key',
      description: 'Brave Search API key - only the Agent Server EC2 can read this',
      secretStringValue: cdk.SecretValue.unsafePlainText(braveApiKey),
    });
    braveSecret.grantRead(agentRole);

    // --- Gateway Token Secret (Agent Server reads, operator populates post-deploy) ---
    const gatewayTokenSecret = new secretsmanager.Secret(this, 'GatewayTokenSecret', {
      secretName: 'openclaw/gateway-token',
      description: 'Gateway authentication token - populated post-deploy, only the Agent Server EC2 can read this',
    });
    gatewayTokenSecret.grantRead(agentRole);

    // --- SSM Parameter (Proxy Server Config) ---
    const proxyServerConfigParam = new ssm.StringParameter(this, 'ProxyServerConfig', {
      parameterName: '/openclaw/proxy-config',
      description: 'Proxy Server provider mapping - domain to secret name and injection method',
      stringValue: JSON.stringify(proxyServerConfig),
    });
    proxyServerConfigParam.grantRead(proxyServerRole);

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

    const proxyServerMachine = resolveAgentMachine(props.proxyServerInstanceType);

    const proxyServerInstance = new ec2.Instance(this, 'ProxyServerInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC, availabilityZones: [props.availabilityZone] },
      instanceType: props.proxyServerInstanceType,
      machineImage: proxyServerMachine.machineImage,
      securityGroup: proxyServerSg,
      role: proxyServerRole,
      requireImdsv2: true,
    });

    // --- Proxy Application (installed from npm) ---
    proxyServerInstance.addUserData(
      ...ubuntuBaseUserData(),
      // npm global prefix for ubuntu user (avoids sudo for npm install -g)
      'sudo -u ubuntu mkdir -p /home/ubuntu/.npm-global',
      'sudo -u ubuntu npm config set prefix /home/ubuntu/.npm-global',
      'echo \'export PATH="/home/ubuntu/.npm-global/bin:$PATH"\' > /etc/profile.d/npm-global.sh',
      'echo \'export PATH="/home/ubuntu/.npm-global/bin:$PATH"\' >> /home/ubuntu/.bashrc',
      // Install proxy from npm (as ubuntu user)
      'sudo -u ubuntu npm install -g openclaw-aws-proxy',
      // Create systemd service (runs as ubuntu user)
      [
        'cat > /etc/systemd/system/openclaw-proxy.service << EOF',
        '[Unit]',
        'Description=OpenClaw LLM Proxy',
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        'User=ubuntu',
        'Group=ubuntu',
        'ExecStart=/home/ubuntu/.npm-global/bin/openclaw-aws-proxy',
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

    const gatewayServerMachine = resolveAgentMachine(props.gatewayServerInstanceType);

    const gatewayServerInstance = new ec2.Instance(this, 'GatewayServerInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC, availabilityZones: [props.availabilityZone] },
      instanceType: props.gatewayServerInstanceType,
      machineImage: gatewayServerMachine.machineImage,
      securityGroup: gatewayServerSg,
      role: gatewayServerRole,
      requireImdsv2: true,
    });

    // --- Gateway Server: Node.js + signal-cli (channel integration dependency) ---
    gatewayServerInstance.addUserData(
      ...ubuntuBaseUserData(),
      // signal-cli (native binary, no JRE needed) -- used by OpenClaw gateway for Signal channel
      'curl -fsSL -o /tmp/signal-cli.tar.gz https://github.com/AsamK/signal-cli/releases/download/v0.14.0/signal-cli-0.14.0-Linux-native.tar.gz',
      'tar xf /tmp/signal-cli.tar.gz -C /usr/local/bin',
      'rm /tmp/signal-cli.tar.gz',
      // npm global prefix for ubuntu user (avoids sudo for npm install -g)
      'sudo -u ubuntu mkdir -p /home/ubuntu/.npm-global',
      'sudo -u ubuntu npm config set prefix /home/ubuntu/.npm-global',
      'echo \'export PATH="/home/ubuntu/.npm-global/bin:$PATH"\' > /etc/profile.d/npm-global.sh',
      'echo \'export PATH="/home/ubuntu/.npm-global/bin:$PATH"\' >> /home/ubuntu/.bashrc',
      // OpenClaw needs this to use plain ws:// over non-loopback (VPC-internal, SG-protected)
      'echo \'export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1\' > /etc/profile.d/openclaw.sh',
      // Enable systemd user instance for ubuntu (persists user services without login)
      'loginctl enable-linger ubuntu',
      // Pre-install OpenClaw (no auto-start -- gateway server depends on manual signal-cli setup)
      'sudo -u ubuntu npm install -g openclaw',
    );

    // --- Private DNS (proxy.vpc) ---
    const hostedZone = new route53.PrivateHostedZone(this, 'InternalZone', {
      zoneName: 'vpc',
      vpc,
    });

    new route53.ARecord(this, 'ProxyServerDns', {
      zone: hostedZone,
      recordName: 'proxy',
      target: route53.RecordTarget.fromIpAddresses(proxyServerInstance.instancePrivateIp),
    });

    new route53.ARecord(this, 'GatewayServerDns', {
      zone: hostedZone,
      recordName: 'gateway',
      target: route53.RecordTarget.fromIpAddresses(gatewayServerInstance.instancePrivateIp),
    });

    // Per-provider subdomains (only for configured providers)
    for (const [, config] of Object.entries(PROVIDER_REGISTRY)) {
      if (!process.env[config.envVar]) continue;

      new route53.ARecord(this, `Dns-${config.subdomain}`, {
        zone: hostedZone,
        recordName: `${config.subdomain}.proxy`,
        target: route53.RecordTarget.fromIpAddresses(proxyServerInstance.instancePrivateIp),
      });
    }

    // --- SSM Session Document (login as ubuntu) ---
    new ssm.CfnDocument(this, 'SessionDocument', {
      name: 'ubuntu',
      documentType: 'Session',
      content: {
        schemaVersion: '1.0',
        description: 'SSM session that logs in as the ubuntu user',
        sessionType: 'Standard_Stream',
        inputs: {
          shellProfile: {
            linux: 'export XDG_RUNTIME_DIR=/run/user/$(id -u ubuntu); exec sudo -u ubuntu -i env XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR bash -l',
          },
        },
      },
    });

    // --- Stack Outputs ---
    new cdk.CfnOutput(this, 'AgentServerInstanceId', {
      value: agentInstance.instanceId,
      description: 'Agent Server EC2 instance ID - use with: aws ssm start-session --target <id> --document-name ubuntu',
    });

    new cdk.CfnOutput(this, 'ProxyServerInstanceId', {
      value: proxyServerInstance.instanceId,
      description: 'Proxy Server EC2 instance ID - use with: aws ssm start-session --target <id> --document-name ubuntu',
    });

    new cdk.CfnOutput(this, 'ProxyServerPrivateIp', {
      value: proxyServerInstance.instancePrivateIp,
      description: 'Proxy Server address: http://proxy.vpc:8080',
    });

    new cdk.CfnOutput(this, 'GatewayServerInstanceId', {
      value: gatewayServerInstance.instanceId,
      description: 'Gateway Server EC2 instance ID - use with: aws ssm start-session --target <id> --document-name ubuntu',
    });

    new cdk.CfnOutput(this, 'GatewayServerPrivateIp', {
      value: gatewayServerInstance.instancePrivateIp,
      description: 'Gateway Server address: ws://gateway.vpc:18789',
    });

    new cdk.CfnOutput(this, 'ProxyServerConfigParameter', {
      value: proxyServerConfigParam.parameterName,
      description: 'SSM Parameter name for the proxy server provider mapping',
    });
  }
}
