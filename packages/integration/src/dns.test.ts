import { readContext } from './context';
import { runCommand } from './ssm-helper';

const ctx = readContext();

describe('DNS Resolution Verification', () => {
  test('gateway.vpc resolves to Gateway Server private IP', async () => {
    const result = await runCommand(
      ctx.agentInstanceId,
      'dig +short gateway.vpc',
    );

    expect(result.stdout.trim()).toBe(ctx.gatewayServerPrivateIp);
  });
});
