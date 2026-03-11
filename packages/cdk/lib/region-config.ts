export function resolveRegionConfig(env: {
  CDK_AZ?: string;
  CDK_AZ_PROD?: string;
}): { region: string; availabilityZone: string } {
  const az = env.CDK_AZ ?? env.CDK_AZ_PROD;

  if (!az) {
    throw new Error(
      'CDK_AZ is not set. Deploy scripts set this automatically from CDK_AZ_PROD or CDK_AZ_TEST in .env.',
    );
  }

  return { region: az.slice(0, -1), availabilityZone: az };
}
