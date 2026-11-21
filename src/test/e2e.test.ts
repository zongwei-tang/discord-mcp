/* End-to-end: MCP client → tools → REST/gateway/QR-login, all against a fake Discord running in-process. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-mcp-test-'));
process.env.DISCORD_MCP_HOME = home;
delete process.env.DISCORD_TOKEN;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ME = { id: '100', username: 'me', global_name: 'Me', discriminator: '0' };
const ALICE = { id: '200', username: 'alice', global_name: 'Alice', discriminator: '0' };
const BOT = { id: '300', username: 'testbot', bot: true, discriminator: '0' };

// ---------------------------------------------------------------- fake gateway
const gwServer = new WebSocketServer({ port: 0 });
let gwSock: WebSocket | undefined;
let gwSeq = 1;
const gwReceived: any[] = [];
function dispatch(t: string, d: any) { gwSock?.send(JSON.stringify({ op: 0, t, s: ++gwSeq, d })); }
const READY = {
  v: 9, user: ME, session_id: 'sess123', resume_gateway_url: '',
  users: [ALICE, BOT],
  guilds: [{
    id: '1000', member_count: 3, properties: { name: 'Test Server', owner_id: '999' },
    roles: [{ id: '1000', name: '@everyone', permissions: String(1024 + 2048 + 65536) }],
    channels: [
      { id: '1100', type: 4, name: 'Text', position: 0 },
      { id: '1101', type: 0, name: 'general', parent_id: '1100', position: 0, last_message_id: '5005', topic: 'chat here' },
      { id: '1102', type: 0, name: 'secret', parent_id: '1100', position: 1, last_message_id: '5006', permission_overwrites: [{ id: '1000', type: 0, allow: '0', deny: '1024' }] },
      { id: '1103', type: 2, name: 'Voice', parent_id: '1100', position: 2 },
    ],
    voice_states: [{ user_id: '200', channel_id: '1103' }],
  }],
  merged_members: [[{ user_id: '100', roles: [] }]],
  private_channels: [{ id: '2001', type: 1, recipient_ids: ['200'], last_message_id: '6001' }],
  read_state: { entries: [{ id: '1101', last_message_id: '5000', mention_count: 2 }, { id: '2001', last_message_id: '6000', mention_count: 0 }], version: 1, partial: false },
  user_guild_settings: { entries: [], version: 1, partial: false },
  relationships: [{ id: '200', type: 1, user_id: '200' }],
};
gwServer.on('connection', (ws) => {
  gwSock = ws;
  ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
  ws.on('message', (raw) => {
    const p = JSON.parse(raw.toString());
    gwReceived.push(p);
    if (p.op === 2) ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { ...READY, resume_gateway_url: `ws://127.0.0.1:${(gwServer.address() as any).port}` } }));
    if (p.op === 1) ws.send(JSON.stringify({ op: 11 }));
    if (p.op === 4) dispatch('VOICE_STATE_UPDATE', { guild_id: p.d.guild_id, channel_id: p.d.channel_id, user_id: ME.id, session_id: 'sess123', self_mute: p.d.self_mute });
    if (p.op === 8) dispatch('GUILD_MEMBERS_CHUNK', { guild_id: p.d.guild_id[0] ?? p.d.guild_id, nonce: p.d.nonce, chunk_index: 0, chunk_count: 1, members: [{ user: ALICE, roles: [], joined_at: '2026-01-01T00:00:00Z' }].filter((m) => m.user.username.startsWith(p.d.query ?? '')) });
  });
});

// ---------------------------------------------------------------- fake remote auth (QR login)
const raServer = new WebSocketServer({ port: 0 });
let clientKey: crypto.KeyObject | undefined;
const enc = (s: string | Buffer) => crypto.publicEncrypt({ key: clientKey!, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(s)).toString('base64');
raServer.on('connection', (ws, req) => {
  assert.equal(req.headers.origin, 'https://discord.com');
  const n = crypto.randomBytes(32);
  ws.send(JSON.stringify({ op: 'hello', heartbeat_interval: 41250, timeout_ms: 120000 }));
  ws.on('message', (raw) => {
    const p = JSON.parse(raw.toString());
    if (p.op === 'init') {
      const der = Buffer.from(p.encoded_public_key, 'base64');
      clientKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
      (ws as any).fp = crypto.createHash('sha256').update(der).digest('base64url');
      ws.send(JSON.stringify({ op: 'nonce_proof', encrypted_nonce: enc(n) }));
    }
    if (p.op === 'nonce_proof') {
      assert.equal(p.nonce, n.toString('base64url'));
      ws.send(JSON.stringify({ op: 'pending_remote_init', fingerprint: (ws as any).fp }));
      setTimeout(() => ws.send(JSON.stringify({ op: 'pending_ticket', encrypted_user_payload: enc('100:0:0:me') })), 100);
      setTimeout(() => ws.send(JSON.stringify({ op: 'pending_login', ticket: 'tkt-1' })), 200);
    }
  });
});

process.env.DISCORD_GATEWAY_URL = `ws://127.0.0.1:${(gwServer.address() as any).port}`;
process.env.DISCORD_REMOTE_AUTH_URL = `ws://127.0.0.1:${(raServer.address() as any).port}/?v=2`;

// ---------------------------------------------------------------- fake REST
interface Call { method: string; path: string; url: URL; headers: Record<string, string>; body: any; form?: FormData }
const calls: Call[] = [];
let roles429 = true;
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const msg = (id: string, extra: any = {}) => ({ id, channel_id: '1101', type: 0, content: `m${id}`, author: ALICE, timestamp: new Date().toISOString(), attachments: [], embeds: [], ...extra });

globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === '127.0.0.1') return new Response('no', { status: 404 });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
  let body: any; let form: FormData | undefined;
  if (init.body instanceof FormData) { const fd: FormData = init.body; form = fd; const pj = fd.get('payload_json'); body = pj ? JSON.parse(String(pj)) : undefined; }
  else if (typeof init.body === 'string') body = JSON.parse(init.body);
  const method = init.method ?? 'GET';
  const p = url.pathname.replace(/^\/api\/v9/, '');
  calls.push({ method, path: p, url, headers, body, form });
  const k = `${method} ${p}`;

  if (k === 'POST /users/@me/remote-auth/login') return json({ encrypted_token: enc('user-token-xyz') });
  if (!headers.authorization) return json({ message: '401: Unauthorized', code: 0 }, 401);
  if (k === 'GET /users/@me') return json({ ...ME, email: 'me@example.com', mfa_enabled: false, verified: true });
  if (k === 'GET /users/@me/guilds') return json([{ id: '1000', name: 'Test Server', owner: false, approximate_member_count: 3, approximate_presence_count: 2 }]);
  if (k === 'GET /users/@me/relationships') return json([{ id: '200', type: 1, user: ALICE, since: '2026-01-01T00:00:00Z' }]);
  if (k === 'POST /channels/1101/messages' || k === 'POST /channels/2001/messages') {
    const fm = form; const files = fm ? [...fm.keys()].filter((x) => x.startsWith("files[")) : [];
    return json(msg('7001', { channel_id: p.split('/')[2], author: ME, content: body.content, attachments: files.map((f, i) => ({ id: String(i), filename: (fm!.get(f) as File).name, size: 3, url: 'https://cdn.discordapp.com/x' })) }));
  }
  if (k === 'GET /channels/1101/messages') {
    const all = Array.from({ length: 150 }, (_, i) => msg(String(5005 - i)));
    const q = url.searchParams; const limit = Number(q.get('limit') ?? 50);
    if (q.get('around') === '7200') return json([msg('7200', { author: BOT, application_id: '300', components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Open', custom_id: 'open_form' }] }] })]);
    let list = all;
    if (q.get('before')) list = list.filter((m) => BigInt(m.id) < BigInt(q.get('before')!));
    return json(list.slice(0, limit));
  }
  if (k === 'GET /guilds/1000/messages/search') return json({ total_results: 1, messages: [[{ ...msg('5005', { content: 'hello world' }), hit: true }]] });
  if (method === 'PUT' && p.startsWith('/channels/1101/messages/5005/reactions/')) return new Response(null, { status: 204 });
  if (k === 'PUT /guilds/1000/bans/200') return new Response(null, { status: 204 });
  if (k === 'POST /guilds/1000/roles') return json({ id: '1500', ...body });
  if (k === 'PATCH /guilds/1000') return json({ id: '1000', name: 'Test Server', icon: 'hash' });
  if (k === 'GET /guilds/1000/roles') { if (roles429) { roles429 = false; return json({ message: 'You are being rate limited.', retry_after: 0.05, global: false }, 429); } return json(READY.guilds[0].roles); }
  if (k === 'GET /guilds/1000/bans') return json({ message: 'Missing Permissions', code: 50013 }, 403);
  if (k === 'POST /invites/abc') return json({ captcha_key: ['captcha-required'], captcha_sitekey: 'x', captcha_service: 'hcaptcha' }, 400);
  if (k === 'GET /guilds/1000/application-command-index') return json({
    applications: [{ id: '300', name: 'TestBot' }],
    application_commands: [{ id: '900', application_id: '300', version: '1', name: 'echo', type: 1, description: 'Echo', options: [{ type: 1, name: 'say', description: 'say', options: [{ type: 3, name: 'text', required: true }, { type: 4, name: 'times' }] }] }],
  });
  if (k === 'GET /users/@me/application-command-index') return json({ applications: [], application_commands: [] });
  if (k === 'POST /interactions') {
    const n = body.nonce;
    setTimeout(() => {
      if (body.type === 3 && body.data.custom_id === 'open_form') {
        dispatch('INTERACTION_MODAL_CREATE', { id: 'm1', nonce: n, custom_id: 'form', title: 'Form', channel_id: '1101', guild_id: '1000', application: { id: '300' }, components: [{ type: 1, components: [{ type: 4, custom_id: 'name', label: 'Name', style: 1 }] }] });
        return;
      }
      dispatch('INTERACTION_SUCCESS', { id: 'i1', nonce: n });
      dispatch('MESSAGE_CREATE', { ...msg('7100', { author: BOT, content: body.type === 5 ? 'thanks Zed' : 'echo: hi', interaction_metadata: { id: 'i1', name: 'echo' } }), guild_id: '1000' });
    }, 30);
    return new Response(null, { status: 204 });
  }
  if (k === 'POST /read-states/ack-bulk') return new Response(null, { status: 204 });
  if (k === 'PATCH /users/@me/settings') return json(body);
  if (k === 'GET /channels/1103') return json(READY.guilds[0].channels[3]);
  return json({ message: `fake discord: no route ${k}`, code: 0 }, 404);
}) as typeof fetch;

// ---------------------------------------------------------------- MCP client
const { buildServer } = await import('../index.js');
const server = buildServer();
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: 'test', version: '1' });
await client.connect(b);

async function call(name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content.find((c: any) => c.type === 'text')?.text ?? '';
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { isError: !!r.isError, data, text, content: r.content };
}
const last = (pred: (c: Call) => boolean) => [...calls].reverse().find(pred)!;

after(() => { gwServer.close(); raServer.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('lists 400+ tools with object schemas', async () => {
  const r = await client.listTools();
  assert.ok(r.tools.length >= 400, `only ${r.tools.length}`);
  for (const t of r.tools) assert.equal(t.inputSchema.type, 'object', t.name);
  const names = new Set(r.tools.map((t) => t.name));
  for (const n of ['send_message', 'read_messages', 'run_slash_command', 'click_button', 'join_voice_channel', 'ban_member', 'create_guild_channel', 'discord_login']) assert.ok(names.has(n), n);
});

test('not logged in: whoami says so', async () => {
  const r = await call('whoami');
  assert.equal(r.data.logged_in, false);
});

test('QR login saves the token and starts the gateway', async () => {
  const r = await call('discord_login');
  assert.ok(r.content.some((c: any) => c.type === 'image' && c.mimeType === 'image/png' && c.data.length > 500));
  assert.match(r.text, /discord\.com\/ra\//);
  const s = await call('discord_login_status', { wait: true });
  assert.equal(s.data.state, 'done');
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'account.json'), 'utf8'));
  assert.equal(saved.token, 'user-token-xyz');
  assert.equal(saved.type, 'user');
  for (let i = 0; i < 50 && !(await call('whoami')).data.gateway?.servers; i++) await sleep(50);
  const w = await call('whoami');
  assert.equal(w.data.gateway.status, 'ready');
  assert.equal(w.data.user.name, 'Me (@me)');
  const ident = gwReceived.find((p) => p.op === 2);
  assert.equal(ident.d.token, 'user-token-xyz');
  assert.equal(ident.d.capabilities, 31);
  assert.equal(ident.d.properties.browser, 'Chrome');
});

test('REST requests look like the web client', async () => {
  const c = last((x) => x.path === '/users/@me');
  assert.equal(c.headers.authorization, 'user-token-xyz');
  const sp = JSON.parse(Buffer.from(c.headers['x-super-properties'], 'base64').toString());
  assert.equal(sp.browser, 'Chrome');
  assert.ok(sp.client_build_number > 0);
  assert.match(c.headers['user-agent'], /Chrome\//);
});

test('servers, channel tree, DMs and unread come from the live cache', async () => {
  const g = await call('list_guilds');
  assert.deepEqual(g.data[0], { id: '1000', name: 'Test Server', members: 3, online: 2, unread_channels: 1, mentions: 2 });
  const t = await call('get_channel_tree', { guild_id: '1000' });
  const chans = t.data.categories[0].channels;
  assert.deepEqual(chans.map((c: any) => c.name), ['general', 'Voice'], 'secret channel is hidden');
  assert.equal(chans[0].unread, true);
  assert.deepEqual(chans[1].voice, ['alice']);
  const d = await call('list_dms');
  assert.equal(d.data[0].label, 'DM with Alice (@alice)');
  assert.equal(d.data[0].unread, true);
  const u = await call('list_unread');
  assert.equal(u.data.dms[0].id, '2001');
  assert.equal(u.data.mentions[0].id, '1101');
  assert.equal(u.data.mentions[0].mentions, 2);
});

test('send_message uploads files and replies', async () => {
  const f = path.join(home, 'note.txt'); fs.writeFileSync(f, 'hey');
  const r = await call('send_message', { channel_id: '1101', content: 'hello', reply_to: '5005', files: [{ path: f }], silent: true });
  assert.equal(r.isError, false, r.text);
  const c = last((x) => x.method === 'POST' && x.path === '/channels/1101/messages');
  assert.equal(c.body.content, 'hello');
  assert.equal(c.body.message_reference.message_id, '5005');
  assert.equal(c.body.flags, 4096);
  assert.equal(c.body.attachments[0].filename, 'note.txt');
  assert.ok(c.form!.get('files[0]') instanceof Blob);
  assert.equal(r.data.attachments[0].filename, 'note.txt');
  const dm = await call('send_dm', { user_id: '200', content: 'hi alice' });
  assert.equal(dm.isError, false, dm.text);
  assert.equal(last((x) => x.method === 'POST' && x.path.endsWith('/messages')).path, '/channels/2001/messages', 'reuses cached DM');
});

test('read_messages paginates and orders oldest first', async () => {
  const r = await call('read_messages', { channel_id: 'https://discord.com/channels/1000/1101', limit: 150 });
  assert.equal(r.data.count, 150);
  assert.equal(r.data.messages[0].id, '4856');
  assert.equal(r.data.messages[149].id, '5005');
  assert.equal(r.data.messages[0].author, 'Alice (@alice)');
  assert.equal(calls.filter((x) => x.path === '/channels/1101/messages' && x.method === 'GET').length >= 2, true);
});

test('search_messages encodes repeated filters', async () => {
  const r = await call('search_messages', { guild_id: '1000', content: 'hello', author_id: ['200', '300'], has: ['link'] });
  assert.equal(r.data.total_results, 1);
  assert.equal(r.data.messages[0].link, 'https://discord.com/channels/1000/1101/5005');
  const c = last((x) => x.path === '/guilds/1000/messages/search');
  assert.deepEqual(c.url.searchParams.getAll('author_id'), ['200', '300']);
});

test('generic endpoint tools: path encoding, reasons, permission names, data URIs', async () => {
  let r = await call('add_reaction', { channel_id: '1101', message_id: '5005', emoji: '👍' });
  assert.equal(r.isError, false, r.text);
  assert.equal(last((x) => x.method === 'PUT').url.pathname, '/api/v9/channels/1101/messages/5005/reactions/%F0%9F%91%8D/@me');
  r = await call('ban_member', { guild_id: '1000', user_id: '200', delete_message_seconds: 3600, reason: 'spam' });
  assert.equal(r.isError, false, r.text);
  const ban = last((x) => x.path === '/guilds/1000/bans/200');
  assert.equal(ban.headers['x-audit-log-reason'], 'spam');
  assert.equal(ban.body.delete_message_seconds, 3600);
  r = await call('create_guild_role', { guild_id: '1000', name: 'Helpers', permissions: ['SEND_MESSAGES', 'VIEW_CHANNEL'], hoist: true });
  assert.equal(r.data.permissions, '3072');
  const png = path.join(home, 'icon.png'); fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  r = await call('modify_guild', { guild_id: '1000', icon: png, custom_field: 'passes through' });
  const mg = last((x) => x.method === 'PATCH' && x.path === '/guilds/1000');
  assert.match(mg.body.icon, /^data:image\/png;base64,/);
  assert.equal(mg.body.custom_field, 'passes through');
});

test('slash commands with subcommands get a reply', async () => {
  const lc = await call('list_commands', { channel_id: '1101' });
  assert.equal(lc.data[0].name, 'echo');
  const r = await call('run_slash_command', { channel_id: '1101', command: '/echo say', options: { text: 'hi', times: '2' } });
  assert.equal(r.data.status, 'ok', r.text);
  assert.equal(r.data.response.content, 'echo: hi');
  const c = last((x) => x.path === '/interactions');
  assert.equal(c.body.type, 2);
  assert.equal(c.body.session_id, 'sess123');
  assert.deepEqual(c.body.data.options, [{ type: 1, name: 'say', options: [{ type: 3, name: 'text', value: 'hi' }, { type: 4, name: 'times', value: 2 }] }]);
});

test('buttons open modals that can be submitted', async () => {
  const r = await call('click_button', { channel_id: '1101', message: '7200', label: 'open' });
  assert.equal(r.data.status, 'modal', r.text);
  assert.equal(r.data.modal.inputs[0].custom_id, 'name');
  const click = last((x) => x.path === '/interactions');
  assert.equal(click.body.data.custom_id, 'open_form');
  assert.equal(click.body.application_id, '300');
  const s = await call('submit_modal', { values: { name: 'Zed' } });
  assert.equal(s.data.response.content, 'thanks Zed', s.text);
  const sub = last((x) => x.path === '/interactions');
  assert.equal(sub.body.type, 5);
  assert.equal(sub.body.data.components[0].components[0].value, 'Zed');
});

test('presence, voice and member search go over the gateway', async () => {
  let r = await call('set_status', { status: 'dnd' });
  assert.equal(r.data.ok, true, r.text);
  assert.equal(last((x) => x.path === '/users/@me/settings').body.status, 'dnd');
  await sleep(50);
  assert.equal(gwReceived.filter((p) => p.op === 3).pop().d.status, 'dnd');
  r = await call('set_activity', { name: 'Chess', type: 'playing' });
  await sleep(50);
  assert.equal(gwReceived.filter((p) => p.op === 3).pop().d.activities[0].name, 'Chess');
  r = await call('join_voice_channel', { channel_id: '1103', self_mute: true });
  assert.equal(r.data.ok, true, r.text);
  assert.deepEqual(gwReceived.filter((p) => p.op === 4).pop().d, { guild_id: '1000', channel_id: '1103', self_mute: true, self_deaf: false, self_video: false });
  r = await call('list_voice_members', { guild_id: '1000' });
  assert.equal(r.data.channels.Voice.length, 2);
  r = await call('search_members', { guild_id: '1000', query: 'ali' });
  assert.equal(r.data.members[0].name, 'Alice (@alice)');
});

test('live events and waiting for a reply', async () => {
  const p = call('wait_for_message', { channel_id: '2001', timeout_seconds: 5 });
  await sleep(100);
  dispatch('MESSAGE_CREATE', { ...msg('6002', { channel_id: '2001', content: 'yo!' }) });
  const r = await p;
  assert.equal(r.data.received, true);
  assert.equal(r.data.message.content, 'yo!');
  const e = await call('get_events', { types: ['MESSAGE_CREATE'], channel_id: '2001' });
  assert.equal(e.data.events.pop().data.content, 'yo!');
  const u = await call('list_unread');
  assert.equal(u.data.dms[0].mentions, 1, 'DM message counts as a mention');
});

test('mark_read acks a whole server in bulk', async () => {
  const r = await call('mark_read', { guild_id: '1000' });
  assert.equal(r.data.marked, 1);
  const c = last((x) => x.path === '/read-states/ack-bulk');
  assert.deepEqual(c.body.read_states.map((s: any) => s.channel_id), ['1101']);
});

test('errors are explained; 429 is retried', async () => {
  let r = await call('list_guild_bans', { guild_id: '1000' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Missing Permissions \(code 50013\).*lacks permission/);
  r = await call('join_server', { invite: 'https://discord.gg/abc' });
  assert.match(r.text, /captcha/);
  r = await call('list_guild_roles', { guild_id: '1000' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data[0].name, '@everyone');
  r = await call('discord_api_request', { method: 'GET', path: 'users/@me' });
  assert.equal(r.data.username, 'me');
});

test('friends and permissions', async () => {
  const f = await call('list_friends');
  assert.deepEqual(f.data, [{ id: '200', type: 'friend', name: 'Alice (@alice)', since: '2026-01-01T00:00:00Z' }]);
  const p = await call('get_my_permissions', { guild_id: '1000', channel_id: '1102' });
  assert.ok(!p.data.permissions.includes('VIEW_CHANNEL'));
  const p2 = await call('get_my_permissions', { guild_id: '1000', channel_id: '1101' });
  assert.ok(p2.data.permissions.includes('SEND_MESSAGES'));
});
