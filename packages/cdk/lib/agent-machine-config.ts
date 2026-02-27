import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ubuntuBaseUserData } from './utils';

/** Configuration for the agent EC2 instance. */
export interface AgentMachineConfig {
  /**
   * EC2 instance type for the agent.
   * Architecture (ARM64 vs x86_64) is auto-detected from the instance type.
   * @default t4g.large
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
 * Resolves the agent machine configuration for the given CPU type.
 * Returns the Ubuntu 24.04 machine image, user data commands, default user, and root device name.
 */
export function resolveAgentMachine(
  cpuType: ec2.AmazonLinuxCpuType,
): ResolvedAgentMachine {
  const arch = cpuType === ec2.AmazonLinuxCpuType.ARM_64 ? 'arm64' : 'amd64';
  return {
    machineImage: ec2.MachineImage.fromSsmParameter(
      `/aws/service/canonical/ubuntu/server/24.04/stable/current/${arch}/hvm/ebs-gp3/ami-id`,
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
