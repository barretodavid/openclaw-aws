/**
 * Schedules deletion of all KMS keys tagged ${AGENT_NAME}:wallet.
 * Runs with the deployer's AWS credentials, not the agent's IAM role.
 * KMS enforces a minimum 7-day waiting period before actual deletion.
 */
import { KMSClient, ScheduleKeyDeletionCommand, DescribeKeyCommand } from '@aws-sdk/client-kms';
import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from '@aws-sdk/client-resource-groups-tagging-api';

async function main() {
  const agentName = process.env.AGENT_NAME;
  if (!agentName) {
    throw new Error('AGENT_NAME is not set in environment');
  }

  const tagging = new ResourceGroupsTaggingAPIClient({});
  const kms = new KMSClient({});

  console.log(`Looking for KMS keys tagged ${agentName}:wallet...`);

  const response = await tagging.send(
    new GetResourcesCommand({
      TagFilters: [{ Key: agentName, Values: ['wallet'] }],
      ResourceTypeFilters: ['kms:key'],
    }),
  );

  const arns = response.ResourceTagMappingList?.map((r) => r.ResourceARN!).filter(Boolean) ?? [];

  if (arns.length === 0) {
    console.log('No wallet keys found.');
    return;
  }

  let count = 0;

  for (const arn of arns) {
    const desc = await kms.send(new DescribeKeyCommand({ KeyId: arn }));
    if (desc.KeyMetadata?.KeyState === 'PendingDeletion') {
      console.log(`  Skipping ${arn} (already pending deletion)`);
      continue;
    }

    console.log(`  Scheduling deletion: ${arn}`);
    await kms.send(new ScheduleKeyDeletionCommand({ KeyId: arn, PendingWindowInDays: 7 }));
    count++;
  }

  console.log(`Scheduled ${count} key(s) for deletion (7-day waiting period).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
