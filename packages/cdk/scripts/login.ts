import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { createClients, discoverInstances, InstanceInfo } from 'shared';

config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const SERVER_FIELD_MAP: Record<string, keyof InstanceInfo> = {
  agent: 'agentInstanceId',
  gateway: 'gatewayServerInstanceId',
};

const server = process.argv[2];

if (!server || !SERVER_FIELD_MAP[server]) {
  console.error(`Usage: login.ts <server>`);
  console.error(`  server: agent | gateway`);
  process.exit(1);
}

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
  const instances = await discoverInstances(cfn, ec2, agentName!);
  const instanceId = instances[SERVER_FIELD_MAP[server]];

  console.log(`Connecting to ${server} server (${agentName}) — ${instanceId}...`);

  execSync(
    `aws ssm start-session --target ${instanceId} --document-name ${agentName} --region ${region}`,
    { stdio: 'inherit' },
  );
}

login().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
