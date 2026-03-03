import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ubuntuBaseUserData } from './utils';

/** Configuration for the agent EC2 instance. */
export interface AgentMachineConfig {
  /**
   * EC2 instance type for the agent. Must be an x86_64 instance type.
   * @default t3a.large
   */
  readonly instanceType?: ec2.InstanceType;
}

/** Resolved machine configuration ready for use in a CDK construct. */
export interface ResolvedAgentMachine {
  readonly machineImage: ec2.IMachineImage;
  readonly userDataCommands: readonly string[];
  readonly defaultUser: string;
  readonly rootDeviceName: string;
}

/**
 * Resolves the agent machine configuration (x86_64 only).
 * Returns the Ubuntu 24.04 machine image, user data commands, default user, and root device name.
 */
export function resolveAgentMachine(
  instanceType: ec2.InstanceType,
): ResolvedAgentMachine {
  if (instanceType.architecture === ec2.InstanceArchitecture.ARM_64) {
    throw new Error(
      `ARM instance types are not supported. Got ${instanceType.toString()} - use an x86_64 type like t3a, m5a, or m7i instead.`,
    );
  }

  return {
    machineImage: ec2.MachineImage.fromSsmParameter(
      '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
      { os: ec2.OperatingSystemType.LINUX },
    ),
    userDataCommands: [
      ...ubuntuBaseUserData(['docker.io']),
      'systemctl enable docker',
      'systemctl start docker',
    ],
    defaultUser: 'ubuntu',
    rootDeviceName: '/dev/sda1',
  };
}
