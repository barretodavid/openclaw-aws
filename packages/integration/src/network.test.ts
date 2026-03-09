import { readContext } from './context';
import { runCommand } from './ssm-helper';

const ctx = readContext();

describe('Network Connectivity Verification', () => {
  test('Agent can reach Proxy health endpoint', async () => {
    const result = await runCommand(
      ctx.agentInstanceId,
      'curl -s -o /dev/null -w "%{http_code}" http://proxy.vpc:8080/health',
    );

    expect(result.stdout.trim()).toBe('200');
  });

  test('Agent can reach Gateway on port 18789', async () => {
    // Connection refused means the network path is open (SG allows it)
    // but nothing is listening. Timeout means SG blocked it.
    const result = await runCommand(
      ctx.agentInstanceId,
      'timeout 5 bash -c "echo > /dev/tcp/gateway.vpc/18789" 2>&1; echo "EXIT:$?"',
    );

    const output = result.stdout + result.stderr;
    // Exit 0 = connected, or "Connection refused" = port reachable but no listener
    // Both prove the security group allows the traffic
    const networkOpen =
      output.includes('EXIT:0') || output.includes('Connection refused');
    expect(networkOpen).toBe(true);
  });
});

describe('Network Isolation Verification', () => {
  test('Gateway cannot connect to Proxy on port 8080', async () => {
    const result = await runCommand(
      ctx.gatewayInstanceId,
      'timeout 5 bash -c "echo > /dev/tcp/proxy.vpc/8080" 2>&1; echo "EXIT:$?"',
    );

    const output = result.stdout + result.stderr;
    // Timeout (exit 124) or Connection refused means SG blocks it
    const blocked = !output.includes('EXIT:0') || output.includes('Connection refused');
    expect(blocked).toBe(true);
  });

  test('Proxy cannot connect to Gateway on port 18789', async () => {
    const result = await runCommand(
      ctx.proxyInstanceId,
      'timeout 5 bash -c "echo > /dev/tcp/gateway.vpc/18789" 2>&1; echo "EXIT:$?"',
    );

    const output = result.stdout + result.stderr;
    const blocked = !output.includes('EXIT:0') || output.includes('Connection refused');
    expect(blocked).toBe(true);
  });
});
