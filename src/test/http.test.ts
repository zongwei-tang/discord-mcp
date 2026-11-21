/* Remote mode: Streamable HTTP with bearer-header or secret-path auth. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DISCORD_MCP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-mcp-http-'));
process.env.DISCORD_GATEWAY = 'off';
delete process.env.DISCORD_TOKEN;

const TOKEN = 'test-token-0123456789-abcdefghij';
const { buildServer, loadTools } = await import('../index.js');
const { startHttpServer } = await import('../remote/http.js');
loadTools();
const srv = await startHttpServer({ host: '127.0.0.1', port: 0, token: TOKEN, buildServer });
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
after(() => srv.close());

async function connect(url: string, headers: Record<string, string> = {}) {
  const c = new Client({ name: 't', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return c;
}

test('health is public', async () => {
  assert.equal(await (await fetch(`${base}/health`)).text(), 'ok');
});

test('rejects missing or wrong tokens', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  const r2 = await fetch(`${base}/mcp/wrong-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r2.status, 401);
});

test('bearer header works and lists all tools', async () => {
  const c = await connect(`${base}/mcp`, { Authorization: `Bearer ${TOKEN}` });
  const t = await c.listTools();
  assert.ok(t.tools.length >= 430);
  const r: any = await c.callTool({ name: 'whoami', arguments: {} });
  assert.match(r.content[0].text, /"logged_in":false/);
  await c.close();
});

test('secret URL path works (for URL-only clients like claude.ai connectors)', async () => {
  const c = await connect(`${base}/mcp/${TOKEN}`);
  const r: any = await c.callTool({ name: 'snowflake_info', arguments: { id: '175928847299117063' } });
  assert.match(r.content[0].text, /2016-04-30/);
  await c.close();
});
