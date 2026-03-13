import * as path from 'node:path';
import { config } from 'dotenv';

config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const az = process.env.CDK_AZ;
if (!az) {
  throw new Error('CDK_AZ is not set. Set it in .env (e.g., CDK_AZ=us-east-1a).');
}

const agentName = process.env.AGENT_NAME;
if (!agentName) {
  throw new Error('AGENT_NAME is not set. Set it in .env (e.g., AGENT_NAME=alice).');
}

export const TEST_REGION = az.slice(0, -1);
export const TEST_AZ = az;
export const AGENT_NAME = agentName;
