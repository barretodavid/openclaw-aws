import { readContext } from './context';
import { runCommand } from './ssm-helper';
import { AGENT_NAME } from './config';

const ctx = readContext();

describe('DNS Resolution Verification', () => {
  test(`gateway.${AGENT_NAME}.vpc resolves to Gateway Server private IP`, async () => {
    const result = await runCommand(
      ctx.agentInstanceId,
      `dig +short gateway.${AGENT_NAME}.vpc`,
    );

    expect(result.stdout.trim()).toBe(ctx.gatewayServerPrivateIp);
  });
});
