import { readContext } from './context';
import { runCommand } from './ssm-helper';

const ctx = readContext();

/** Run a command as the ubuntu user (picks up ubuntu's PATH for npm globals). */
function asUbuntu(command: string): string {
  return `sudo -u ubuntu bash -lc '${command}'`;
}

describe('Software Provisioning', () => {
  describe('Agent Server', () => {
    test('node is installed', async () => {
      const result = await runCommand(ctx.agentInstanceId, 'which node');
      expect(result.exitCode).toBe(0);
    });

    test('docker is installed', async () => {
      const result = await runCommand(ctx.agentInstanceId, 'which docker');
      expect(result.exitCode).toBe(0);
    });

    test('aws CLI is installed', async () => {
      const result = await runCommand(ctx.agentInstanceId, 'which aws');
      expect(result.exitCode).toBe(0);
    });

    test('openclaw is installed', async () => {
      const result = await runCommand(ctx.agentInstanceId, asUbuntu('which openclaw'));
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Proxy Server', () => {
    test('node is installed', async () => {
      const result = await runCommand(ctx.proxyServerInstanceId, 'which node');
      expect(result.exitCode).toBe(0);
    });

    test('aws CLI is installed', async () => {
      const result = await runCommand(ctx.proxyServerInstanceId, 'which aws');
      expect(result.exitCode).toBe(0);
    });

    test('openclaw-aws-proxy is installed', async () => {
      const result = await runCommand(ctx.proxyServerInstanceId, asUbuntu('which openclaw-aws-proxy'));
      expect(result.exitCode).toBe(0);
    });
  });

  describe('Gateway Server', () => {
    test('node is installed', async () => {
      const result = await runCommand(ctx.gatewayServerInstanceId, 'which node');
      expect(result.exitCode).toBe(0);
    });

    test('aws CLI is installed', async () => {
      const result = await runCommand(ctx.gatewayServerInstanceId, 'which aws');
      expect(result.exitCode).toBe(0);
    });

    test('signal-cli is installed', async () => {
      const result = await runCommand(ctx.gatewayServerInstanceId, asUbuntu('which signal-cli'));
      expect(result.exitCode).toBe(0);
    });

    test('openclaw is installed', async () => {
      const result = await runCommand(ctx.gatewayServerInstanceId, asUbuntu('which openclaw'));
      expect(result.exitCode).toBe(0);
    });
  });
});
