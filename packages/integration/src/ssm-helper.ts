import { createClients, runCommand as sharedRunCommand, type CommandResult } from 'shared';
import { TEST_REGION } from './config';

const { ssm } = createClients(TEST_REGION);

export type { CommandResult };

/** Run a shell command on an EC2 instance via SSM and return the result. */
export async function runCommand(
  instanceId: string,
  command: string,
): Promise<CommandResult> {
  return sharedRunCommand(ssm, instanceId, command);
}
