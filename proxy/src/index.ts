import * as http from 'node:http';
import { loadConfig } from './config.js';
import { createHandler } from './handler.js';

const PORT = parseInt(process.env['PROXY_PORT'] ?? '8080', 10);
const CONFIG_PARAM = process.env['PROXY_CONFIG_PARAM'] ?? '/openclaw/proxy-config';

async function main(): Promise<void> {
  console.log(`Loading proxy config from SSM parameter: ${CONFIG_PARAM}`);
  const config = await loadConfig(CONFIG_PARAM);
  console.log(`Loaded ${config.size} provider(s): ${[...config.keys()].join(', ')}`);

  const handler = createHandler(config);
  const server = http.createServer(handler);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Proxy listening on 0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal: failed to start proxy', err);
  process.exit(1);
});
