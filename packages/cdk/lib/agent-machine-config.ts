import * as ec2 from 'aws-cdk-lib/aws-ec2';

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
      'apt-get update -y',
      'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -',
      'apt-get install -y docker.io nodejs unattended-upgrades',
      'systemctl enable docker',
      'systemctl start docker',
      // Automatic daily security upgrades with reboot at 03:00 UTC when needed
      [
        "cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'",
        'APT::Periodic::Update-Package-Lists "1";',
        'APT::Periodic::Unattended-Upgrade "1";',
        'EOF',
      ].join('\n'),
      [
        "cat > /etc/apt/apt.conf.d/52unattended-upgrades-local << 'EOF'",
        'Unattended-Upgrade::Automatic-Reboot "true";',
        'Unattended-Upgrade::Automatic-Reboot-Time "03:00";',
        'EOF',
      ].join('\n'),
      'systemctl enable unattended-upgrades',
    ],
    defaultUser: 'ubuntu',
    rootDeviceName: '/dev/sda1',
  };
}
