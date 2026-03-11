import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { createClients, discoverInstances, waitForSsmReady, waitForCloudInit } from 'shared';

config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const az = process.env.CDK_AZ_TEST;
if (!az) {
  throw new Error('CDK_AZ_TEST is not set in .env');
}

const region = az.slice(0, -1);
const STACK_NAME = 'OpenclawStack';

console.log(`Deploying ${STACK_NAME} (test) to ${region} (${az})...`);

execSync('cdk deploy --require-approval never', {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  env: {
    ...process.env,
    CDK_AZ: az,
    AWS_DEFAULT_REGION: region,
    CDK_DEFAULT_REGION: region,
  },
});

console.log('Deploy complete. Waiting for instances to be ready...\n');

async function waitForReady() {
  const { cfn, ec2, ssm } = createClients(region);

  const instances = await discoverInstances(cfn, ec2, STACK_NAME);
  const instanceIds = [
    instances.agentInstanceId,
    instances.proxyServerInstanceId,
    instances.gatewayServerInstanceId,
  ];

  await waitForSsmReady(ssm, instanceIds);
  await waitForCloudInit(ssm, instanceIds);

  console.log('\nAll servers ready!\n');
  console.log(`  Agent Server     ${instances.agentInstanceId}`);
  console.log(`  Proxy Server     ${instances.proxyServerInstanceId}`);
  console.log(`  Gateway Server   ${instances.gatewayServerInstanceId}`);
  console.log('\nConnect with:');
  console.log(`  aws ssm start-session --target ${instances.agentInstanceId}   # Agent`);
  console.log(`  aws ssm start-session --target ${instances.proxyServerInstanceId}   # Proxy`);
  console.log(`  aws ssm start-session --target ${instances.gatewayServerInstanceId}   # Gateway`);
}

waitForReady().catch((err) => {
  console.error('Failed waiting for instances:', err);
  process.exit(1);
});
