import * as fs from 'node:fs';
import * as path from 'node:path';

const CONTEXT_FILE = path.join(__dirname, '..', '.test-context.json');

export interface TestContext {
  agentInstanceId: string;
  proxyInstanceId: string;
  gatewayInstanceId: string;
  proxyPrivateIp: string;
  gatewayPrivateIp: string;
}

export function writeContext(ctx: TestContext): void {
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2));
}

export function readContext(): TestContext {
  return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
}

export function cleanupContext(): void {
  if (fs.existsSync(CONTEXT_FILE)) {
    fs.unlinkSync(CONTEXT_FILE);
  }
}
