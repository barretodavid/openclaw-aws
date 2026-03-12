import { createClients, discoverInstances, waitForSsmReady, waitForCloudInit } from 'shared';
import { writeContext } from './context';
import { TEST_REGION } from './config';

const STACK_NAME = 'OpenclawStack';

export default async function globalSetup(): Promise<void> {
  console.log(`\nDiscovering ${STACK_NAME} instances in ${TEST_REGION}...`);

  const { cfn, ec2, ssm } = createClients(TEST_REGION);

  const instances = await discoverInstances(cfn, ec2, STACK_NAME);

  console.log(`Agent: ${instances.agentInstanceId}, Gateway Server: ${instances.gatewayServerInstanceId}`);

  const instanceIds = [
    instances.agentInstanceId,
    instances.gatewayServerInstanceId,
  ];

  await waitForSsmReady(ssm, instanceIds);
  await waitForCloudInit(ssm, instanceIds);

  writeContext(instances);

  console.log('Global setup complete.\n');
}
