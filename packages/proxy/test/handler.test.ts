import * as http from 'node:http';
import * as https from 'node:https';
import { createHandler } from '../src/handler.js';
import type { ProxyConfig, ProviderEntry } from '../src/config.js';

// Mock getApiKey so we don't hit real AWS
jest.mock('../src/config.js', () => ({
  ...jest.requireActual('../src/config.js'),
  getApiKey: jest.fn().mockResolvedValue('real-secret-key'),
}));

// Mock https.request to capture outbound requests
jest.mock('node:https');

const mockConfig: ProxyConfig = new Map<string, ProviderEntry>([
  ['anthropic', {
    backendDomain: 'api.anthropic.com',
    secretName: 'openclaw/anthropic-api-key',
    inject: { type: 'header', name: 'x-api-key' },
    api: 'anthropic',
  }],
  ['openai', {
    backendDomain: 'api.openai.com',
    secretName: 'openclaw/openai-api-key',
    inject: { type: 'header', name: 'Authorization', prefix: 'Bearer ' },
    api: 'openai',
  }],
  ['alchemy', {
    backendDomain: 'starknet-mainnet.g.alchemy.com',
    secretName: 'openclaw/alchemy-api-key',
    inject: { type: 'path' },
    api: null,
  }],
]);

let server: http.Server;
let port: number;

function request(options: http.RequestOptions & { host: string }, body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    // Connect to 127.0.0.1 but set the Host header to simulate DNS routing
    const { host, headers: extraHeaders, ...rest } = options;
    const req = http.request({
      ...rest,
      hostname: '127.0.0.1',
      port,
      headers: { ...extraHeaders, host },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

beforeAll((done) => {
  const handler = createHandler(mockConfig);
  server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => {
    port = (server.address() as { port: number }).port;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();

  // Set up https.request mock to simulate a backend response
  (https.request as jest.Mock).mockImplementation((_options: https.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
    const fakeRes = new http.IncomingMessage(null as unknown as import('node:net').Socket);
    fakeRes.statusCode = 200;
    Object.defineProperty(fakeRes, 'headers', { value: { 'content-type': 'application/json' }, writable: true });

    // Simulate async response delivery
    process.nextTick(() => {
      callback(fakeRes);
      fakeRes.push('{"ok":true}');
      fakeRes.push(null);
    });

    // Return a writable stream that accepts piped data
    const fakeReq = new (require('node:stream').PassThrough)();
    fakeReq.destroyed = false;
    fakeReq.destroy = jest.fn();
    fakeReq.on = fakeReq.on.bind(fakeReq);
    return fakeReq;
  });
});

describe('Proxy Handler', () => {
  test('health check returns 200', async () => {
    const res = await request({ method: 'GET', path: '/health', host: 'proxy.vpc' });
    expect(res.status).toBe(200);
  });

  test('returns 404 for base domain without /health', async () => {
    const res = await request({ method: 'GET', path: '/v1/messages', host: 'proxy.vpc' });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toContain('No provider subdomain');
  });

  test('returns 404 for unknown provider', async () => {
    const res = await request({ method: 'GET', path: '/', host: 'unknown.proxy.vpc' });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toContain('Unknown provider: unknown');
  });

  test('header injection: sets x-api-key for Anthropic', async () => {
    await request({ method: 'POST', path: '/v1/messages', host: 'anthropic.proxy.vpc:8080' }, '{}');

    expect(https.request).toHaveBeenCalledTimes(1);
    const callArgs = (https.request as jest.Mock).mock.calls[0][0] as https.RequestOptions;
    const headers = callArgs.headers as Record<string, string>;
    expect(callArgs.hostname).toBe('api.anthropic.com');
    expect(callArgs.path).toBe('/v1/messages');
    expect(headers['x-api-key']).toBe('real-secret-key');
  });

  test('header injection: sets Authorization Bearer for OpenAI', async () => {
    await request({ method: 'POST', path: '/v1/chat/completions', host: 'openai.proxy.vpc:8080' }, '{}');

    const callArgs = (https.request as jest.Mock).mock.calls[0][0] as https.RequestOptions;
    const headers = callArgs.headers as Record<string, string>;
    expect(callArgs.hostname).toBe('api.openai.com');
    expect(headers['Authorization']).toBe('Bearer real-secret-key');
  });

  test('path injection: appends API key for Alchemy', async () => {
    await request({ method: 'POST', path: '/starknet/v0_7', host: 'alchemy.proxy.vpc:8080' }, '{}');

    const callArgs = (https.request as jest.Mock).mock.calls[0][0] as https.RequestOptions;
    expect(callArgs.hostname).toBe('starknet-mainnet.g.alchemy.com');
    expect(callArgs.path).toBe('/starknet/v0_7/real-secret-key');
  });

  test('path injection: handles trailing slash', async () => {
    await request({ method: 'POST', path: '/starknet/v0_7/', host: 'alchemy.proxy.vpc:8080' }, '{}');

    const callArgs = (https.request as jest.Mock).mock.calls[0][0] as https.RequestOptions;
    expect(callArgs.path).toBe('/starknet/v0_7/real-secret-key');
  });

  test('strips hop-by-hop headers from outbound request', async () => {
    await request({
      method: 'POST',
      path: '/v1/messages',
      host: 'anthropic.proxy.vpc:8080',
      headers: { 'connection': 'keep-alive', 'content-type': 'application/json' },
    }, '{}');

    const callArgs = (https.request as jest.Mock).mock.calls[0][0] as https.RequestOptions;
    const headers = callArgs.headers as Record<string, string>;
    expect(headers['connection']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
  });

  test('forwards backend response status and body', async () => {
    const res = await request({ method: 'POST', path: '/v1/messages', host: 'anthropic.proxy.vpc:8080' }, '{}');

    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
  });
});
