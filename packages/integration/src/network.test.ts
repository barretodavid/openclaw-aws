import { readContext } from './context';
import { runCommand } from './ssm-helper';

const ctx = readContext();

describe('Network Connectivity Verification', () => {
  test('Server can reach the internet via HTTPS', async () => {
    const result = await runCommand(
      ctx.instanceId,
      'curl -sSf -o /dev/null -w "%{http_code}" https://api.ipify.org 2>&1 || true',
    );

    const output = result.stdout.trim();
    expect(output).toBe('200');
  });
});
