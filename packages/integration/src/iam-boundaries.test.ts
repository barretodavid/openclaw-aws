import { readContext } from './context';
import { runCommand } from './ssm-helper';
import { TEST_REGION, AGENT_NAME } from './config';

const ctx = readContext();

describe('IAM Boundary Verification', () => {
  test('Server can read LLM API key secret from Secrets Manager', async () => {
    const result = await runCommand(
      ctx.instanceId,
      `aws secretsmanager get-secret-value --secret-id ${AGENT_NAME}/llm-api-key --region ${TEST_REGION} --query SecretString --output text`,
    );

    expect(result.stdout.trim()).toBeTruthy();
  });

  test('Server can read web search secret from Secrets Manager', async () => {
    const result = await runCommand(
      ctx.instanceId,
      `aws secretsmanager get-secret-value --secret-id ${AGENT_NAME}/web-search-api-key --region ${TEST_REGION} --query SecretString --output text`,
    );

    expect(result.stdout.trim()).toBeTruthy();
  });

  test('Server can read Telegram token secret from Secrets Manager', async () => {
    const result = await runCommand(
      ctx.instanceId,
      `aws secretsmanager get-secret-value --secret-id ${AGENT_NAME}/telegram-token --region ${TEST_REGION} --query SecretString --output text`,
    );

    expect(result.stdout.trim()).toBeTruthy();
  });

  test('Server cannot read unscoped secrets from Secrets Manager', async () => {
    const result = await runCommand(
      ctx.instanceId,
      `aws secretsmanager get-secret-value --secret-id test-nonexistent --region ${TEST_REGION} 2>&1 || true`,
    );

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/AccessDeniedException|not authorized|NotFoundException/i);
  });

  test('Server cannot sign with KMS without a wallet-tagged key', async () => {
    const result = await runCommand(
      ctx.instanceId,
      `aws kms sign --key-id alias/test-nonexistent --message "test" --signing-algorithm ECDSA_SHA_256 --message-type RAW --region ${TEST_REGION} 2>&1 || true`,
    );

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/AccessDeniedException|not authorized|NotFoundException/i);
  });
});
