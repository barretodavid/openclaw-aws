import * as ec2 from 'aws-cdk-lib/aws-ec2';

export const config = {
  /** Availability zone for both EC2 instances. Must match your configured AWS region. */
  availabilityZone: 'ca-central-1b',

  /** EC2 instance type for the agent. Must be x86_64 (e.g. t3a, m5a, m7i). */
  agentInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.LARGE),

  /** EC2 instance type for the proxy. Must be x86_64. */
  proxyInstanceType: ec2.InstanceType.of(ec2.InstanceClass.T3A, ec2.InstanceSize.NANO),

  /** Root EBS volume size (GB) for the agent instance. */
  agentVolumeGb: 30,
};
