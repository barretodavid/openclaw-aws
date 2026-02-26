import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export interface InjectConfig {
  type: 'header' | 'path';
  name?: string;   // header name (only for type: 'header')
  prefix?: string; // e.g. "Bearer " (only for type: 'header')
}

export interface ProviderEntry {
  backendDomain: string;
  secretName: string;
  inject: InjectConfig;
  api: string | null;
}

export type ProxyConfig = Map<string, ProviderEntry>;

const ssm = new SSMClient();
const sm = new SecretsManagerClient();

const secretCache = new Map<string, string>();

export async function loadConfig(parameterName: string): Promise<ProxyConfig> {
  const resp = await ssm.send(new GetParameterCommand({ Name: parameterName }));
  const raw = resp.Parameter?.Value;
  if (!raw) throw new Error(`SSM parameter ${parameterName} is empty`);

  const parsed: Record<string, ProviderEntry> = JSON.parse(raw);
  return new Map(Object.entries(parsed));
}

export async function getApiKey(secretName: string): Promise<string> {
  const cached = secretCache.get(secretName);
  if (cached) return cached;

  const resp = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
  const value = resp.SecretString;
  if (!value) throw new Error(`Secret ${secretName} is empty`);

  secretCache.set(secretName, value);
  return value;
}
