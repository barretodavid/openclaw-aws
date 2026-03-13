export function resolveRegionConfig(env: {
  CDK_AZ?: string;
}): { region: string; availabilityZone: string } {
  const az = env.CDK_AZ;

  if (!az) {
    throw new Error(
      'CDK_AZ is not set. Set it in .env (e.g., CDK_AZ=us-east-1a).',
    );
  }

  return { region: az.slice(0, -1), availabilityZone: az };
}
