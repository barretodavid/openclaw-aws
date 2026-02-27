import * as ec2 from 'aws-cdk-lib/aws-ec2';

/** Supported operating system families for the agent EC2 instance. */
export enum AgentOsFamily {
  AMAZON_LINUX_2023 = 'amazon-linux-2023',
  AMAZON_LINUX_2 = 'amazon-linux-2',
  UBUNTU_24_04 = 'ubuntu-24.04',
}

/** Configuration for the agent EC2 instance. */
export interface AgentMachineConfig {
  /**
   * EC2 instance type for the agent.
   * Architecture (ARM64 vs x86_64) is auto-detected from the instance type.
   * @default t4g.large
   */
  readonly instanceType?: ec2.InstanceType;

  /**
   * Operating system for the agent EC2 instance.
   * The AMI and user data scripts are selected automatically.
   * @default AgentOsFamily.UBUNTU_24_04
   */
  readonly osFamily?: AgentOsFamily;
}

/** Resolved machine configuration ready for use in a CDK construct. */
export interface ResolvedAgentMachine {
  readonly machineImage: ec2.IMachineImage;
  readonly userDataCommands: readonly string[];
  readonly defaultUser: string;
  readonly rootDeviceName: string;
}

interface OsFamilyDef {
  machineImage: (cpuType: ec2.AmazonLinuxCpuType) => ec2.IMachineImage;
  userDataCommands: string[];
  defaultUser: string;
  rootDeviceName: string;
}

const OS_FAMILY_REGISTRY: Record<AgentOsFamily, OsFamilyDef> = {
  [AgentOsFamily.AMAZON_LINUX_2023]: {
    machineImage: (cpuType) => ec2.MachineImage.latestAmazonLinux2023({ cpuType }),
    userDataCommands: [
      'dnf update -y',
      'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
      'dnf install -y docker nodejs',
      'systemctl enable docker',
      'systemctl start docker',
    ],
    defaultUser: 'ec2-user',
    rootDeviceName: '/dev/xvda',
  },

  [AgentOsFamily.AMAZON_LINUX_2]: {
    machineImage: (cpuType) => ec2.MachineImage.latestAmazonLinux2({ cpuType }),
    userDataCommands: [
      'yum update -y',
      'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
      'yum install -y docker nodejs',
      'systemctl enable docker',
      'systemctl start docker',
    ],
    defaultUser: 'ec2-user',
    rootDeviceName: '/dev/xvda',
  },

  [AgentOsFamily.UBUNTU_24_04]: {
    machineImage: (cpuType) => {
      const arch = cpuType === ec2.AmazonLinuxCpuType.ARM_64 ? 'arm64' : 'amd64';
      return ec2.MachineImage.fromSsmParameter(
        `/aws/service/canonical/ubuntu/server/24.04/stable/current/${arch}/hvm/ebs-gp3/ami-id`,
        { os: ec2.OperatingSystemType.LINUX },
      );
    },
    userDataCommands: [
      'apt-get update -y',
      'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
      'apt-get install -y docker.io nodejs',
      'systemctl enable docker',
      'systemctl start docker',
    ],
    defaultUser: 'ubuntu',
    rootDeviceName: '/dev/sda1',
  },
};

/**
 * Resolves the agent machine configuration for a given OS family and CPU type.
 * Returns the machine image, user data commands, default user, and root device name.
 */
export function resolveAgentMachine(
  osFamily: AgentOsFamily,
  cpuType: ec2.AmazonLinuxCpuType,
): ResolvedAgentMachine {
  const def = OS_FAMILY_REGISTRY[osFamily];
  return {
    machineImage: def.machineImage(cpuType),
    userDataCommands: def.userDataCommands,
    defaultUser: def.defaultUser,
    rootDeviceName: def.rootDeviceName,
  };
}
