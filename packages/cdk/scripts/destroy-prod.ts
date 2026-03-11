import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';

config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const az = process.env.CDK_AZ_PROD;
if (!az) {
  throw new Error('CDK_AZ_PROD is not set in .env');
}

const region = az.slice(0, -1);
const cdkDir = path.resolve(__dirname, '..');
const envVars = {
  ...process.env,
  CDK_AZ: az,
  AWS_DEFAULT_REGION: region,
  CDK_DEFAULT_REGION: region,
};

console.log(`Destroying OpenclawStack in ${region}...`);

try {
  execSync('ts-node scripts/cleanup-wallet-keys.ts', {
    cwd: cdkDir,
    stdio: 'inherit',
    env: envVars,
  });

  execSync('cdk destroy --force', {
    cwd: cdkDir,
    stdio: 'inherit',
    env: envVars,
  });

  console.log('Stack destroyed.');
} catch (err) {
  console.error('WARNING: Stack teardown failed. Manual cleanup may be required.');
  console.error(err);
}
