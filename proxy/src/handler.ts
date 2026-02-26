import * as http from 'node:http';
import * as https from 'node:https';
import { type ProxyConfig, type ProviderEntry, getApiKey } from './config.js';

// Hop-by-hop headers that must not be forwarded (RFC 2616 Section 13.5.1)
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'host',
]);

function jsonError(res: http.ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function extractSubdomain(host: string | undefined): string | null {
  if (!host) return null;
  // Strip port: "anthropic.proxy.vpc:8080" -> "anthropic.proxy.vpc"
  const hostname = host.split(':')[0];
  // Split labels: ["anthropic", "proxy", "vpc"]
  const labels = hostname.split('.');
  // "proxy.vpc" (2 labels) = base domain, no subdomain
  // "anthropic.proxy.vpc" (3 labels) = subdomain is first label
  if (labels.length <= 2) return null;
  return labels[0];
}

function buildOutboundHeaders(
  incomingHeaders: http.IncomingHttpHeaders,
  provider: ProviderEntry,
  apiKey: string,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  // Inject the real API key
  if (provider.inject.type === 'header') {
    const headerName = provider.inject.name!;
    const prefix = provider.inject.prefix ?? '';
    out[headerName] = `${prefix}${apiKey}`;
  }

  return out;
}

function buildOutboundPath(reqPath: string, provider: ProviderEntry, apiKey: string): string {
  if (provider.inject.type === 'path') {
    // Append API key as final path segment: /starknet/v0_7 -> /starknet/v0_7/<key>
    const base = reqPath.endsWith('/') ? reqPath.slice(0, -1) : reqPath;
    return `${base}/${apiKey}`;
  }
  return reqPath;
}

export function createHandler(config: ProxyConfig): http.RequestListener {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Health check (base domain proxy.vpc or explicit path)
    if (req.url === '/health') {
      jsonError(res, 200, 'ok');
      return;
    }

    const subdomain = extractSubdomain(req.headers.host);
    if (!subdomain) {
      jsonError(res, 404, 'No provider subdomain in Host header. Use <provider>.proxy.vpc:8080');
      return;
    }

    const provider = config.get(subdomain);
    if (!provider) {
      jsonError(res, 404, `Unknown provider: ${subdomain}`);
      return;
    }

    let apiKey: string;
    try {
      apiKey = await getApiKey(provider.secretName);
    } catch (err) {
      console.error(`Failed to fetch secret ${provider.secretName}:`, err);
      jsonError(res, 502, 'Failed to fetch API key from Secrets Manager');
      return;
    }

    const path = buildOutboundPath(req.url ?? '/', provider, apiKey);
    const headers = buildOutboundHeaders(req.headers, provider, apiKey);

    const options: https.RequestOptions = {
      hostname: provider.backendDomain,
      port: 443,
      path,
      method: req.method,
      headers,
    };

    const backendReq = https.request(options, (backendRes) => {
      res.writeHead(backendRes.statusCode ?? 502, backendRes.headers);
      backendRes.pipe(res);
    });

    backendReq.on('error', (err) => {
      console.error(`Backend request to ${provider.backendDomain} failed:`, err);
      if (!res.headersSent) {
        jsonError(res, 502, `Backend unreachable: ${provider.backendDomain}`);
      } else {
        res.end();
      }
    });

    // If the client disconnects before sending the full body, abort the backend request
    req.on('close', () => {
      if (!req.complete && !backendReq.destroyed) backendReq.destroy();
    });

    // Pipe the agent's request body to the backend
    req.pipe(backendReq);
  };
}
