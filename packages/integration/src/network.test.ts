import { readContext } from './context';
import { runCommand } from './ssm-helper';

const ctx = readContext();

describe('Network Connectivity Verification', () => {
  test('Agent Server can reach Gateway Server on port 18789', async () => {
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
