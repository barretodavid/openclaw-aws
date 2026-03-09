import { execSync } from 'node:child_process';
import { TEST_REGION, TEST_AZ } from '../src/config';

const STACK_NAME = 'OpenclawStack';
const CDK_APP = 'npx ts-node ../../packages/cdk/bin/openclaw.ts';

console.log(`Deploying ${STACK_NAME} to ${TEST_REGION}...`);

execSync(
  `npx cdk deploy ${STACK_NAME} --app "${CDK_APP}" --require-approval never`,
  {
    cwd: `${__dirname}/../../../packages/cdk`,
    stdio: 'inherit',
    env: {
      ...process.env,
      AWS_DEFAULT_REGION: TEST_REGION,
      CDK_DEFAULT_REGION: TEST_REGION,
      CDK_AVAILABILITY_ZONE: TEST_AZ,
    },
  },
);

console.log('Deploy complete.');
