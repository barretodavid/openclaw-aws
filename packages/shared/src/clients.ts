import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { EC2Client } from '@aws-sdk/client-ec2';
import { SSMClient } from '@aws-sdk/client-ssm';
import { fromIni } from '@aws-sdk/credential-provider-ini';

export interface AwsClients {
  cfn: CloudFormationClient;
  ec2: EC2Client;
  ssm: SSMClient;
}

export function createClients(region: string): AwsClients {
  const credentials = fromIni();
  const config = { region, credentials };
  return {
    cfn: new CloudFormationClient(config),
    ec2: new EC2Client(config),
    ssm: new SSMClient(config),
  };
}
