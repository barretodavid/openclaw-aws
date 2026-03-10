import * as path from 'node:path';
import { config } from 'dotenv';

config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const prodAz = process.env.CDK_AZ_PROD;
const testAz = process.env.CDK_AZ_TEST;

if (!prodAz) {
  throw new Error('CDK_AZ_PROD is not set. Set it in .env (e.g., CDK_AZ_PROD=us-east-1a).');
}

if (!testAz) {
  throw new Error('CDK_AZ_TEST is not set. Set it in .env (e.g., CDK_AZ_TEST=us-east-2a).');
}

const prodRegion = prodAz.slice(0, -1);
const testRegion = testAz.slice(0, -1);

if (prodRegion === testRegion) {
  throw new Error(
    `CDK_AZ_PROD (${prodAz}) and CDK_AZ_TEST (${testAz}) must be in different regions to avoid resource collisions.`,
  );
}

export const TEST_REGION = testRegion;
export const TEST_AZ = testAz;
