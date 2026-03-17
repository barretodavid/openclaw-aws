import { createClients, discoverInstances, waitForSsmReady, waitForCloudInit } from 'shared';
import { writeContext } from './context';
import { TEST_REGION, AGENT_NAME } from './config';

export default async function globalSetup(): Promise<void> {
  console.log(`\nDiscovering ${AGENT_NAME} instance in ${TEST_REGION}...`);

  const { cfn, ec2, ssm } = createClients(TEST_REGION);

  const { instanceId } = await discoverInstances(cfn, ec2, AGENT_NAME);

  console.log(`Instance: ${instanceId}`);

  await waitForSsmReady(ssm, [instanceId]);
  await waitForCloudInit(ssm, [instanceId]);

  writeContext({ instanceId });

  console.log('Global setup complete.\n');
}
