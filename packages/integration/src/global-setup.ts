import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import {
  EC2Client,
  DescribeInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  SSMClient,
  DescribeInstanceInformationCommand,
} from '@aws-sdk/client-ssm';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { runCommand } from './ssm-helper';
import { writeContext } from './context';
import { TEST_REGION } from './config';

const STACK_NAME = 'OpenclawStack';
const MAX_READINESS_WAIT_MS = 300_000; // 5 minutes
const POLL_INTERVAL_MS = 10_000;

export default async function globalSetup(): Promise<void> {
  console.log(`\nDiscovering ${STACK_NAME} instances in ${TEST_REGION}...`);

  const credentials = fromIni();
  const regionConfig = { region: TEST_REGION, credentials };
  const ec2 = new EC2Client(regionConfig);
  const cfn = new CloudFormationClient(regionConfig);
  const ssm = new SSMClient(regionConfig);

  // Verify stack exists
  const stackResult = await cfn.send(
    new DescribeStacksCommand({ StackName: STACK_NAME }),
  );
  if (!stackResult.Stacks?.length) {
    throw new Error(
      `Stack ${STACK_NAME} not found in ${TEST_REGION}. Run 'pnpm run test:deploy' first.`,
    );
  }

  // Find instances tagged with this stack
  const instances = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:aws:cloudformation:stack-name', Values: [STACK_NAME] },
        { Name: 'instance-state-name', Values: ['running'] },
      ],
    }),
  );

  const allInstances = instances.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
  if (allInstances.length !== 3) {
    throw new Error(`Expected 3 running instances, found ${allInstances.length}`);
  }

  // Identify instances by IAM role
  let agentInstanceId = '';
  let proxyInstanceId = '';
  let gatewayInstanceId = '';
  let proxyPrivateIp = '';
  let gatewayPrivateIp = '';

  for (const instance of allInstances) {
    const iamProfile = instance.IamInstanceProfile?.Arn ?? '';
    const id = instance.InstanceId!;
    const privateIp = instance.PrivateIpAddress!;

    if (iamProfile.includes('Agent')) {
      agentInstanceId = id;
    } else if (iamProfile.includes('Proxy')) {
      proxyInstanceId = id;
      proxyPrivateIp = privateIp;
    } else if (iamProfile.includes('Gateway')) {
      gatewayInstanceId = id;
      gatewayPrivateIp = privateIp;
    }
  }

  if (!agentInstanceId || !proxyInstanceId || !gatewayInstanceId) {
    throw new Error(
      `Could not identify all instances. Agent: ${agentInstanceId}, Proxy: ${proxyInstanceId}, Gateway: ${gatewayInstanceId}`,
    );
  }

  console.log(`Agent: ${agentInstanceId}, Proxy: ${proxyInstanceId}, Gateway: ${gatewayInstanceId}`);

  // Wait for SSM agent readiness
  console.log('Waiting for SSM agent readiness...');
  const instanceIds = [agentInstanceId, proxyInstanceId, gatewayInstanceId];
  const started = Date.now();

  while (Date.now() - started < MAX_READINESS_WAIT_MS) {
    const info = await ssm.send(new DescribeInstanceInformationCommand({}));
    const onlineIds = new Set(
      info.InstanceInformationList?.filter((i) => i.PingStatus === 'Online').map(
        (i) => i.InstanceId,
      ) ?? [],
    );

    if (instanceIds.every((id) => onlineIds.has(id))) {
      console.log('All instances SSM-ready.');
      break;
    }

    const missing = instanceIds.filter((id) => !onlineIds.has(id));
    console.log(`Waiting for SSM on: ${missing.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // Verify SSM readiness (loop may have exited due to timeout)
  const finalInfo = await ssm.send(new DescribeInstanceInformationCommand({}));
  const finalOnline = new Set(
    finalInfo.InstanceInformationList?.filter((i) => i.PingStatus === 'Online').map(
      (i) => i.InstanceId,
    ) ?? [],
  );
  const ssmMissing = instanceIds.filter((id) => !finalOnline.has(id));
  if (ssmMissing.length > 0) {
    throw new Error(
      `SSM readiness timeout after ${MAX_READINESS_WAIT_MS / 1000}s. Instances not ready: ${ssmMissing.join(', ')}`,
    );
  }

  // Wait for cloud-init to finish on all instances
  console.log('Waiting for cloud-init completion...');
  const cloudInitStart = Date.now();

  for (const id of instanceIds) {
    while (Date.now() - cloudInitStart < MAX_READINESS_WAIT_MS) {
      const result = await runCommand(id, 'test -f /var/lib/cloud/instance/boot-finished && echo READY || echo WAITING');
      if (result.stdout.trim() === 'READY') {
        console.log(`Cloud-init complete on ${id}`);
        break;
      }
      console.log(`Waiting for cloud-init on ${id}...`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  // Verify cloud-init completed on all instances
  const notReady: string[] = [];
  for (const id of instanceIds) {
    const result = await runCommand(id, 'test -f /var/lib/cloud/instance/boot-finished && echo READY || echo WAITING');
    if (result.stdout.trim() !== 'READY') {
      notReady.push(id);
    }
  }
  if (notReady.length > 0) {
    throw new Error(
      `Cloud-init timeout after ${MAX_READINESS_WAIT_MS / 1000}s. Instances not ready: ${notReady.join(', ')}`,
    );
  }

  writeContext({
    agentInstanceId,
    proxyInstanceId,
    gatewayInstanceId,
    proxyPrivateIp,
    gatewayPrivateIp,
  });

  console.log('Global setup complete.\n');
}
