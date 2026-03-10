export function resolveRegionConfig(env: {
  CDK_AVAILABILITY_ZONE?: string;
  CDK_DEFAULT_REGION?: string;
}): { region: string; availabilityZone: string } {
  const az = env.CDK_AVAILABILITY_ZONE
    ?? (env.CDK_DEFAULT_REGION ? `${env.CDK_DEFAULT_REGION}a` : undefined);

  if (!az) {
    throw new Error(
      'Cannot resolve region: set CDK_AVAILABILITY_ZONE in .env or configure a default region in your AWS profile.',
    );
  }

  return { region: az.slice(0, -1), availabilityZone: az };
}
