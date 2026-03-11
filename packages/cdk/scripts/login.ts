import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { createClients, discoverInstances, InstanceInfo } from 'shared';

config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const STACK_NAME = 'OpenclawStack';

const SERVER_FIELD_MAP: Record<string, keyof InstanceInfo> = {
  agent: 'agentInstanceId',
  proxy: 'proxyServerInstanceId',
  gateway: 'gatewayServerInstanceId',
};

const server = process.argv[2];
const env = process.argv[3] ?? 'prod';

if (!server || !SERVER_FIELD_MAP[server]) {
  console.error(`Usage: login.ts <server> [environment]`);
  console.error(`  server:      agent | proxy | gateway`);
  console.error(`  environment: prod (default) | test`);
  process.exit(1);
}

const azKey = env === 'test' ? 'CDK_AZ_TEST' : 'CDK_AZ_PROD';
const az = process.env[azKey];
if (!az) {
  throw new Error(`${azKey} is not set in .env`);
}

const region = az.slice(0, -1);

async function login() {
  const { cfn, ec2 } = createClients(region);
  const instances = await discoverInstances(cfn, ec2, STACK_NAME);
  const instanceId = instances[SERVER_FIELD_MAP[server]];

  console.log(`Connecting to ${server} server (${env}) — ${instanceId}...`);

  execSync(
    `aws ssm start-session --target ${instanceId} --document-name ubuntu --region ${region}`,
    { stdio: 'inherit' },
  );
}

login().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
