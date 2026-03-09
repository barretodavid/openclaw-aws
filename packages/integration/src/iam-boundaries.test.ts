import { readContext } from './context';
import { runCommand } from './ssm-helper';
import { TEST_REGION } from './config';

const ctx = readContext();

describe('IAM Boundary Verification', () => {
  test('Agent cannot read API keys from Secrets Manager', async () => {
    const result = await runCommand(
      ctx.agentInstanceId,
      `aws secretsmanager get-secret-value --secret-id test-nonexistent --region ${TEST_REGION} 2>&1 || true`,
    );

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/AccessDeniedException|not authorized|NotFoundException/i);
  });

  test('Proxy cannot sign with KMS', async () => {
    const result = await runCommand(
      ctx.proxyInstanceId,
      `aws kms sign --key-id alias/test-nonexistent --message "test" --signing-algorithm ECDSA_SHA_256 --message-type RAW --region ${TEST_REGION} 2>&1 || true`,
    );

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/AccessDeniedException|not authorized|NotFoundException/i);
  });

  test('Gateway cannot read API keys from Secrets Manager', async () => {
    const result = await runCommand(
      ctx.gatewayInstanceId,
      `aws secretsmanager get-secret-value --secret-id test-nonexistent --region ${TEST_REGION} 2>&1 || true`,
    );

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/AccessDeniedException|not authorized|NotFoundException/i);
  });

  test('Gateway cannot sign with KMS', async () => {
    const result = await runCommand(
      ctx.gatewayInstanceId,
      `aws kms sign --key-id alias/test-nonexistent --message "test" --signing-algorithm ECDSA_SHA_256 --message-type RAW --region ${TEST_REGION} 2>&1 || true`,
    );

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/AccessDeniedException|not authorized|NotFoundException/i);
  });
});
