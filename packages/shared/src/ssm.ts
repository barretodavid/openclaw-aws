import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from '@aws-sdk/client-ssm';

const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 90_000;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run a shell command on an EC2 instance via SSM and return the result. */
export async function runCommand(
  ssm: SSMClient,
  instanceId: string,
  command: string,
): Promise<CommandResult> {
  const send = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: 'AWS-RunShellScript',
      Parameters: { commands: [command] },
    }),
  );

  const commandId = send.Command!.CommandId!;
  const started = Date.now();

  while (Date.now() - started < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const result = await ssm.send(
      new GetCommandInvocationCommand({
        CommandId: commandId,
        InstanceId: instanceId,
      }),
    );

    const status = result.Status;
    if (status === 'Success' || status === 'Failed') {
      return {
        exitCode: result.ResponseCode ?? (status === 'Success' ? 0 : 1),
        stdout: result.StandardOutputContent ?? '',
        stderr: result.StandardErrorContent ?? '',
      };
    }

    if (status === 'Cancelled' || status === 'TimedOut') {
      return {
        exitCode: 1,
        stdout: result.StandardOutputContent ?? '',
        stderr: result.StandardErrorContent ?? `Command ${status}`,
      };
    }
  }

  throw new Error(
    `SSM command ${commandId} on ${instanceId} did not complete within ${MAX_WAIT_MS}ms`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
