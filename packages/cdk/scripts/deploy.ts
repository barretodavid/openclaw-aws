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

console.log('Deploy complete. Waiting for instance to be ready...\n');

async function waitForReady() {
  const { cfn, ec2, ssm } = createClients(region);

  const { instanceId } = await discoverInstances(cfn, ec2, agentName!);

  await waitForSsmReady(ssm, [instanceId]);
  await waitForCloudInit(ssm, [instanceId]);

  console.log('\nServer ready!\n');
  console.log(`  Instance   ${instanceId}`);
  console.log('\nConnect with:');
  console.log(`  aws ssm start-session --target ${instanceId} --document-name ${agentName}`);
}

waitForReady().catch((err) => {
  console.error('Failed waiting for instance:', err);
  process.exit(1);
});
