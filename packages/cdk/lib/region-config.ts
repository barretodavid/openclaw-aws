export function resolveRegionConfig(env: {
  CDK_AZ_PROD?: string;
}): { region: string; availabilityZone: string } {
  const az = env.CDK_AZ_PROD;

  if (!az) {
    throw new Error(
      'CDK_AZ_PROD is not set. Set it in .env (e.g., CDK_AZ_PROD=us-east-1a).',
    );
  }

  return { region: az.slice(0, -1), availabilityZone: az };
}
