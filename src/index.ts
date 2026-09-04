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
import { readPortEnv, runMcp } from '@chrischall/mcp-utils';
import { HomesClient } from './client.js';
import { FetchproxyTransport } from './transport-fetchproxy.js';
import { registerSearchTools } from './tools/search.js';
import { registerPropertyTools } from './tools/properties.js';
import { registerMortgageTools } from './tools/mortgage.js';
import { registerCompareTools } from './tools/compare.js';
import { registerAffordabilityTools } from './tools/affordability.js';
import { registerPhotosTools } from './tools/photos.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerHistoryTools } from './tools/history.js';
import { registerNearbyTools } from './tools/nearby.js';
import { registerMarketTools } from './tools/market.js';
import { registerSavedTools } from './tools/saved.js';
import { registerRentVsBuyTools } from './tools/rent-vs-buy.js';
import { registerByAddressTools } from './tools/by-address.js';
import { createSessionRegistry } from '@chrischall/mcp-utils/session';
import { registerSessionsTools } from './tools/sessions.js';
import { registerBulkGetTools } from './tools/bulk-get.js';
import { registerResolveAddressesTools } from './tools/resolve-addresses.js';

const VERSION = '1.4.0'; // x-release-please-version

// Shared strict port parser: integer 1–65535 or the fetchproxy default
// (37149) on anything unset/unparseable.
const port = readPortEnv('HOMES_WS_PORT', 37149);

const transport = new FetchproxyTransport({ port, version: VERSION });

// client.start() before runMcp: auth is per-request so tools/list succeeds without a signed-in tab.
const client = new HomesClient({ transport });
await client.start();

const sessions = createSessionRegistry();

await runMcp({
  name: 'homes-mcp',
  version: VERSION,
  banner:
    `[homes-mcp] v${VERSION} — WebSocket bridge via @fetchproxy/server on 127.0.0.1:${port}. ` +
    'Install the fetchproxy extension (see https://github.com/chrischall/fetchproxy) ' +
    'and sign into homes.com. This project was developed and is maintained by AI (Claude). ' +
    'Use at your own discretion.',
  tools: [
    (server) => registerSearchTools(server, client),
    (server) => registerPropertyTools(server, client),
    (server) => registerMortgageTools(server),
    (server) => registerCompareTools(server, client),
    (server) => registerAffordabilityTools(server),
    (server) => registerPhotosTools(server, client),
    (server) => registerHealthcheckTools(server, client),
    (server) => registerHistoryTools(server, client),
    (server) => registerNearbyTools(server, client),
    (server) => registerMarketTools(server, client),
    (server) => registerSavedTools(server, client),
    (server) => registerRentVsBuyTools(server),
    (server) => registerByAddressTools(server, client),
    (server) => registerSessionsTools(server, sessions),
    (server) => registerBulkGetTools(server, client),
    (server) => registerResolveAddressesTools(server, client),
  ],
  shutdown: { onSignal: () => client.close() },
});
