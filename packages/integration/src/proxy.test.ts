import { readContext } from './context';
import { runCommand } from './ssm-helper';

const ctx = readContext();

describe('Proxy Verification', () => {
  test('Proxy health endpoint responds 200', async () => {
    const result = await runCommand(
      ctx.agentInstanceId,
      'curl -s -o /dev/null -w "%{http_code}" http://proxy.vpc:8080/health',
    );

    expect(result.stdout.trim()).toBe('200');
  });

  test('Request through proxy to real LLM provider succeeds', async () => {
    // First check if anthropic subdomain is configured (DNS resolves)
    const dnsCheck = await runCommand(
      ctx.agentInstanceId,
      'dig +short anthropic.proxy.vpc',
    );

    if (!dnsCheck.stdout.trim()) {
      console.warn('Anthropic provider not configured - skipping proxy key injection test');
      return;
    }

    // Send a minimal request through the proxy to Anthropic.
    // The proxy should fetch the API key from Secrets Manager and inject it.
    const result = await runCommand(
      ctx.agentInstanceId,
      `curl -s -o /dev/null -w "%{http_code}" -X POST http://anthropic.proxy.vpc:8080/v1/messages \
        -H "Content-Type: application/json" \
        -H "anthropic-version: 2023-06-01" \
        -d '{"model":"claude-sonnet-4-20250514","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`,
    );

    const statusCode = result.stdout.trim();
    // 200 = success (proxy injected key correctly)
    // 401/403 = proxy did NOT inject key (test fails)
    expect(statusCode).toBe('200');
  });
});
