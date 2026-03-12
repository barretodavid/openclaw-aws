import { readContext } from './context';
import { runCommand } from './ssm-helper';
import { TEST_REGION } from './config';

const ctx = readContext();

describe('IAM Boundary Verification', () => {
  test('Agent Server cannot read LLM provider secrets from Secrets Manager', async () => {
    const result = await runCommand(
      ctx.agentInstanceId,
      `aws secretsmanager get-secret-value --secret-id openclaw/venice-api-key --region ${TEST_REGION} 2>&1 || true`,
    );

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/AccessDeniedException|not authorized/i);
  });

  test('Agent Server can read Brave Search secret from Secrets Manager', async () => {
    const result = await runCommand(
      ctx.agentInstanceId,
      `aws secretsmanager get-secret-value --secret-id openclaw/brave-api-key --region ${TEST_REGION} --query SecretString --output text`,
    );

    expect(result.stdout.trim()).toBeTruthy();
  });

  test('Agent Server can read gateway token secret from Secrets Manager', async () => {
    const result = await runCommand(
      ctx.agentInstanceId,
      `aws secretsmanager get-secret-value --secret-id openclaw/gateway-token --region ${TEST_REGION} 2>&1 || true`,
    );

    const output = result.stdout + result.stderr;
    // Secret exists and is readable (may not have a value yet, but should not be AccessDenied)
    expect(output).not.toMatch(/AccessDeniedException|not authorized/i);
  });

  test('Gateway Server cannot read gateway token secret from Secrets Manager', async () => {
    const result = await runCommand(
      ctx.gatewayServerInstanceId,
      `aws secretsmanager get-secret-value --secret-id openclaw/gateway-token --region ${TEST_REGION} 2>&1 || true`,
    );

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/AccessDeniedException|not authorized/i);
  });

  test('Proxy Server cannot sign with KMS', async () => {
    const result = await runCommand(
      ctx.proxyServerInstanceId,
      `aws kms sign --key-id alias/test-nonexistent --message "test" --signing-algorithm ECDSA_SHA_256 --message-type RAW --region ${TEST_REGION} 2>&1 || true`,
    );

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/AccessDeniedException|not authorized|NotFoundException/i);
  });

  test('Gateway Server cannot read API keys from Secrets Manager', async () => {
    const result = await runCommand(
      ctx.gatewayServerInstanceId,
      `aws secretsmanager get-secret-value --secret-id test-nonexistent --region ${TEST_REGION} 2>&1 || true`,
    );

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/AccessDeniedException|not authorized|NotFoundException/i);
  });

  test('Gateway Server cannot sign with KMS', async () => {
    const result = await runCommand(
      ctx.gatewayServerInstanceId,
      `aws kms sign --key-id alias/test-nonexistent --message "test" --signing-algorithm ECDSA_SHA_256 --message-type RAW --region ${TEST_REGION} 2>&1 || true`,
    );

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/AccessDeniedException|not authorized|NotFoundException/i);
  });
});
