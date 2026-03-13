import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { createClients, discoverInstances, waitForSsmReady, waitForCloudInit } from 'shared';

config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const agentName = process.env.AGENT_NAME;
if (!agentName) {
  throw new Error('AGENT_NAME is not set in .env');
}

const az = process.env.CDK_AZ;
if (!az) {
  throw new Error('CDK_AZ is not set in .env');
}

const region = az.slice(0, -1);

console.log(`Deploying ${agentName} to ${region} (${az})...`);

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

  const instances = await discoverInstances(cfn, ec2, agentName!);
  const instanceIds = [
    instances.agentInstanceId,
    instances.gatewayServerInstanceId,
  ];

  await waitForSsmReady(ssm, instanceIds);
  await waitForCloudInit(ssm, instanceIds);

  console.log('\nAll servers ready!\n');
  console.log(`  Agent Server     ${instances.agentInstanceId}`);
  console.log(`  Gateway Server   ${instances.gatewayServerInstanceId}`);
  console.log('\nConnect with:');
  console.log(`  aws ssm start-session --target ${instances.agentInstanceId} --document-name ${agentName}   # Agent`);
  console.log(`  aws ssm start-session --target ${instances.gatewayServerInstanceId} --document-name ${agentName}   # Gateway`);
}

waitForReady().catch((err) => {
  console.error('Failed waiting for instances:', err);
  process.exit(1);
});
