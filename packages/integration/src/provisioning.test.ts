import { readContext } from './context';
import { runCommand } from './ssm-helper';

const ctx = readContext();

/** Run a command as the ubuntu user (picks up ubuntu's PATH for npm globals). */
function asUbuntu(command: string): string {
  return `sudo -u ubuntu bash -lc '${command}'`;
}

describe('Software Provisioning', () => {
  test('node is installed', async () => {
    const result = await runCommand(ctx.instanceId, 'which node');
    expect(result.exitCode).toBe(0);
  });

  test('docker is installed', async () => {
    const result = await runCommand(ctx.instanceId, 'which docker');
    expect(result.exitCode).toBe(0);
  });

  test('aws CLI is installed', async () => {
    const result = await runCommand(ctx.instanceId, 'which aws');
    expect(result.exitCode).toBe(0);
  });

  test('signal-cli is installed', async () => {
    const result = await runCommand(ctx.instanceId, 'which signal-cli');
    expect(result.exitCode).toBe(0);
  });

  test('openclaw is installed', async () => {
    const result = await runCommand(ctx.instanceId, asUbuntu('which openclaw'));
    expect(result.exitCode).toBe(0);
  });
});
