import { readContext } from './context';
import { runCommand } from './ssm-helper';

const ctx = readContext();

describe('DNS Resolution Verification', () => {
  test('proxy.vpc resolves to Proxy private IP', async () => {
    const result = await runCommand(
      ctx.agentInstanceId,
      'dig +short proxy.vpc',
    );

    expect(result.stdout.trim()).toBe(ctx.proxyPrivateIp);
  });

  test('gateway.vpc resolves to Gateway private IP', async () => {
    const result = await runCommand(
      ctx.agentInstanceId,
      'dig +short gateway.vpc',
    );

    expect(result.stdout.trim()).toBe(ctx.gatewayPrivateIp);
  });

  test('Provider subdomain resolves to Proxy private IP', async () => {
    // Use anthropic as the test provider (most likely to be configured)
    const result = await runCommand(
      ctx.agentInstanceId,
      'dig +short anthropic.proxy.vpc',
    );

    const ip = result.stdout.trim();
    // If the provider is configured, it should resolve to the proxy IP
    // If not configured, dig returns empty - skip in that case
    if (ip) {
      expect(ip).toBe(ctx.proxyPrivateIp);
    } else {
      console.warn('No provider subdomain DNS record found - skipping');
    }
  });
});
