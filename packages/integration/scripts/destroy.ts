import { execSync } from 'node:child_process';
import { TEST_REGION, TEST_AZ } from '../src/config';

const STACK_NAME = 'OpenclawStack';
const CDK_APP = 'npx ts-node ../../packages/cdk/bin/openclaw.ts';

console.log(`Destroying ${STACK_NAME} in ${TEST_REGION}...`);

try {
  execSync(
    `npx cdk destroy ${STACK_NAME} --app "${CDK_APP}" --force`,
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
  console.log('Stack destroyed.');
} catch (err) {
  console.error('WARNING: Stack teardown failed. Manual cleanup may be required.');
  console.error(err);
}
