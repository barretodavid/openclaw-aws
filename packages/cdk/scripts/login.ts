import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { createClients, discoverInstances } from 'shared';

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

async function login() {
  const { cfn, ec2 } = createClients(region);
  const { instanceId } = await discoverInstances(cfn, ec2, agentName!);

  console.log(`Connecting to ${agentName} — ${instanceId}...`);

  execSync(
    `aws ssm start-session --target ${instanceId} --document-name ${agentName} --region ${region}`,
    { stdio: 'inherit' },
  );
}

login().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
