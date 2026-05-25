#!/usr/bin/env node
// homes-mcp entrypoint.
//
// Boot sequence:
//   1. Construct a FetchproxyTransport listening on 127.0.0.1:37149.
//      The shared fetchproxy Chrome/Safari extension — installed
//      separately, not in this repo — connects here.
//      See https://github.com/chrischall/fetchproxy.
//   2. HomesClient.start() — brings the transport up.
//   3. Register tool handlers against the MCP server.
//   4. Connect the MCP server to stdio for the host client.
//
// The transport outlives the MCP session. On SIGINT/SIGTERM we close it
// so ports/connections don't leak between client restarts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HomesClient } from './client.js';
import { FetchproxyTransport } from './transport-fetchproxy.js';
import { registerSearchTools } from './tools/search.js';
import { registerPropertyTools } from './tools/properties.js';
import { registerMortgageTools } from './tools/mortgage.js';
import { registerCompareTools } from './tools/compare.js';
import { registerAffordabilityTools } from './tools/affordability.js';
import { registerPhotosTools } from './tools/photos.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';

const VERSION = '0.6.0'; // x-release-please-version

const port = process.env.HOMES_WS_PORT
  ? Number(process.env.HOMES_WS_PORT)
  : undefined;

const transport = new FetchproxyTransport({ port, version: VERSION });

const client = new HomesClient({ transport });
await client.start();

const server = new McpServer({ name: 'homes-mcp', version: VERSION });

registerSearchTools(server, client);
registerPropertyTools(server, client);
registerMortgageTools(server);
registerCompareTools(server, client);
registerAffordabilityTools(server);
registerPhotosTools(server, client);
registerHealthcheckTools(server, client);

console.error(
  `[homes-mcp] v${VERSION} — WebSocket bridge via @fetchproxy/server on 127.0.0.1:${port ?? 37149}. ` +
    'Install the fetchproxy extension (see https://github.com/chrischall/fetchproxy) ' +
    'and sign into homes.com. This project was developed and is maintained by AI (Claude). ' +
    'Use at your own discretion.'
);

const shutdown = async () => {
  await client.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const stdio = new StdioServerTransport();
await server.connect(stdio);
