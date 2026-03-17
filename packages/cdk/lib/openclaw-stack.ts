import * as dotenv from 'dotenv';
import * as path from 'node:path';
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { resolveAgentMachine, requireWebProvider, requireLlmProvider, resolveRpcProvider, resolveTelegramToken } from './ec2-config';

export interface OpenclawStackProps extends cdk.StackProps {
  /** Agent name used to scope all AWS resources. */
  readonly agentName: string;
  /** EC2 instance type. Must be x86_64. */
  readonly instanceType: ec2.InstanceType;
  /** Availability zone for the EC2 instance. */
  readonly availabilityZone: string;
  /** Root EBS volume size (GB). */
  readonly volumeGb: number;
}

export class OpenclawStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OpenclawStackProps) {
    super(scope, id, props);

    const { agentName } = props;

    // --- Default VPC ---
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // --- Security Group ---
    const sg = new ec2.SecurityGroup(this, 'AgentSg', {
      vpc,
      description: 'Agent Server EC2 - no inbound, outbound HTTPS broadly',
      allowAllOutbound: false,
    });
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Outbound HTTPS');
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Outbound HTTP (apt/package repos)');

    // --- IAM Role ---
    const role = new iam.Role(this, 'AgentRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Agent Server EC2 role - KMS wallet management, Secrets Manager, SSM Session Manager',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Create wallet keys -- only ECC_NIST_P256 SIGN_VERIFY with the ${agentName}:wallet tag
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:CreateKey'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          [`aws:RequestTag/${agentName}`]: 'wallet',
          'kms:KeySpec': 'ECC_NIST_P256',
          'kms:KeyUsage': 'SIGN_VERIFY',
        },
      },
    }));

    // Tag wallet keys (required by CreateKey when tags are specified).
    // No aws:RequestTag condition here -- KMS does not propagate request
    // tags to the implicit kms:TagResource authorization during CreateKey.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:TagResource'],
      resources: ['*'],
    }));

    // Use wallet-tagged keys (sign, get public key, describe)
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Sign', 'kms:GetPublicKey', 'kms:DescribeKey'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          [`aws:ResourceTag/${agentName}`]: 'wallet',
        },
      },
    }));

    // Discover wallet keys via Resource Groups Tagging API
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['tag:GetResources'],
      resources: ['*'],
    }));

    // --- Validate Required Keys ---
    const llmApiKey = requireLlmProvider();
    const rpcApiKey = resolveRpcProvider();
    const telegramToken = resolveTelegramToken();

    // --- LLM API Key Secret ---
    const llmSecret = new secretsmanager.Secret(this, 'LlmApiKeySecret', {
      secretName: `${agentName}/llm-api-key`,
      description: 'LLM provider API key',
      secretStringValue: cdk.SecretValue.unsafePlainText(llmApiKey),
    });
    llmSecret.grantRead(role);

    // --- RPC API Key Secret (optional) ---
    if (rpcApiKey) {
      const rpcSecret = new secretsmanager.Secret(this, 'RpcApiKeySecret', {
        secretName: `${agentName}/rpc-api-key`,
        description: 'RPC provider API key',
        secretStringValue: cdk.SecretValue.unsafePlainText(rpcApiKey),
      });
      rpcSecret.grantRead(role);
    }

    // --- Web Search Secret ---
    const webApiKey = requireWebProvider();
    const webSecret = new secretsmanager.Secret(this, 'WebApiKeySecret', {
      secretName: `${agentName}/web-search-api-key`,
      description: 'Web search provider API key',
      secretStringValue: cdk.SecretValue.unsafePlainText(webApiKey),
    });
    webSecret.grantRead(role);

    // --- Telegram Bot Token Secret (optional) ---
    if (telegramToken) {
      const telegramSecret = new secretsmanager.Secret(this, 'TelegramTokenSecret', {
        secretName: `${agentName}/telegram-token`,
        description: 'Telegram bot token',
        secretStringValue: cdk.SecretValue.unsafePlainText(telegramToken),
      });
      telegramSecret.grantRead(role);
    }

    // --- EC2 Instance ---

    const machine = resolveAgentMachine(props.instanceType);

    const instance = new ec2.Instance(this, 'AgentInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC, availabilityZones: [props.availabilityZone] },
      instanceType: props.instanceType,
      machineImage: machine.machineImage,
      securityGroup: sg,
      role,
      blockDevices: [
        {
          deviceName: machine.rootDeviceName,
          volume: ec2.BlockDeviceVolume.ebs(props.volumeGb, { volumeType: ec2.EbsDeviceVolumeType.GP3 }),
        },
      ],
      requireImdsv2: true,
    });

    // --- User Data: Docker + Node.js + signal-cli + OpenClaw ---
    instance.addUserData(
      ...machine.userDataCommands,
      `usermod -aG docker ${machine.defaultUser}`,
      // signal-cli (native binary, no JRE needed) -- used by OpenClaw for Signal channel
      'curl -fsSL -o /tmp/signal-cli.tar.gz https://github.com/AsamK/signal-cli/releases/download/v0.14.0/signal-cli-0.14.0-Linux-native.tar.gz',
      'tar xf /tmp/signal-cli.tar.gz -C /usr/local/bin',
      'rm /tmp/signal-cli.tar.gz',
    );

    // --- SSM Session Document (login as ubuntu) ---
    new ssm.CfnDocument(this, 'SessionDocument', {
      name: agentName,
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
    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: `EC2 instance ID - use with: aws ssm start-session --target <id> --document-name ${agentName}`,
    });
  }
}
