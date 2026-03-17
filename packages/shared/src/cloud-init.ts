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
import { runCommand } from './ssm';

const MAX_READINESS_WAIT_MS = 300_000; // 5 minutes
const POLL_INTERVAL_MS = 10_000;

export interface InstanceInfo {
  instanceId: string;
}

/**
 * Discover the EC2 instance for a deployed CDK stack by looking up
 * instances tagged with the stack name.
 */
export async function discoverInstances(
  cfn: CloudFormationClient,
  ec2: EC2Client,
  stackName: string,
): Promise<InstanceInfo> {
  // Verify stack exists
  const stackResult = await cfn.send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  if (!stackResult.Stacks?.length) {
    throw new Error(`Stack ${stackName} not found.`);
  }

  // Find instances tagged with this stack
  const instances = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:aws:cloudformation:stack-name', Values: [stackName] },
        { Name: 'instance-state-name', Values: ['running'] },
      ],
    }),
  );

  const allInstances = instances.Reservations?.flatMap((r) => r.Instances ?? []) ?? [];
  if (allInstances.length !== 1) {
    throw new Error(`Expected 1 running instance, found ${allInstances.length}`);
  }

  return {
    instanceId: allInstances[0].InstanceId!,
  };
}

/**
 * Wait for SSM agent to be online on all given instances.
 */
export async function waitForSsmReady(
  ssm: SSMClient,
  instanceIds: string[],
): Promise<void> {
  console.log('Waiting for SSM agent readiness...');
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
      return;
    }

    const missing = instanceIds.filter((id) => !onlineIds.has(id));
    console.log(`Waiting for SSM on: ${missing.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // Verify after loop (may have exited due to timeout)
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
}

/**
 * Wait for cloud-init to finish on all given instances.
 * Polls /var/lib/cloud/instance/boot-finished via SSM.
 */
export async function waitForCloudInit(
  ssm: SSMClient,
  instanceIds: string[],
): Promise<void> {
  console.log('Waiting for cloud-init completion...');
  const started = Date.now();

  for (const id of instanceIds) {
    while (Date.now() - started < MAX_READINESS_WAIT_MS) {
      const result = await runCommand(ssm, id, 'test -f /var/lib/cloud/instance/boot-finished && echo READY || echo WAITING');
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
    const result = await runCommand(ssm, id, 'test -f /var/lib/cloud/instance/boot-finished && echo READY || echo WAITING');
    if (result.stdout.trim() !== 'READY') {
      notReady.push(id);
    }
  }
  if (notReady.length > 0) {
    throw new Error(
      `Cloud-init timeout after ${MAX_READINESS_WAIT_MS / 1000}s. Instances not ready: ${notReady.join(', ')}`,
    );
  }
}
