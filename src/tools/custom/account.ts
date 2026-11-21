/* Login (QR code / token), logout, who am I, connection status. */
import { ACCOUNT_FILE, clearAccount, currentAccount, parseToken, saveAccount, settings, tokenFromEnv } from '../../config.js';
import { buildNumber } from '../../discord/client-props.js';
import { userName } from '../../discord/format.js';
import { gateway, startGatewayInBackground } from '../../discord/gateway.js';
import { getLogin, startQrLogin } from '../../discord/remote-auth.js';
import { rest } from '../../discord/rest.js';
import { defineTool, z } from '../registry.js';

function loginView(l = getLogin()) {
  if (!l) return { state: 'none', message: 'No login in progress. Call discord_login.' };
  const base = { login_id: l.id, state: l.state };
  if (l.state === 'waiting_for_scan') return {
    ...base,
    instructions: 'Open the Discord app on your phone → tap your avatar/Settings → "Scan QR Code", and scan this code. Then call discord_login_status with wait=true.',
    url: l.url, expires_in_seconds: l.expiresAt ? Math.max(0, Math.round((l.expiresAt - Date.now()) / 1000)) : undefined,
  };
  if (l.state === 'scanned') return { ...base, user: l.user?.username, message: 'Scanned. Confirm "Yes, log me in" on your phone.' };
  if (l.state === 'done') return { ...base, user: l.user?.username, message: `Logged in. Saved to ${ACCOUNT_FILE}.` };
  return { ...base, error: l.error };
}

defineTool({
  name: 'discord_login', category: 'account', noAuth: true,
  description: 'Log in to your personal Discord account by QR code (no password): returns a QR image to scan with the Discord phone app (Settings → Scan QR Code). Then call discord_login_status with wait=true. The token is saved locally.',
  shape: {},
  handler: async () => {
    const l = await startQrLogin();
    l.done.then(() => { if (l.state === 'done') { gateway.close(); gateway.status = 'idle'; startGatewayInBackground(); } });
    const v = loginView(l);
    return { __image: { data: l.qrPng!, mimeType: 'image/png' }, text: `${JSON.stringify(v)}\n\nIf the image does not show, open this QR in any QR generator: ${l.url}\nTerminal version:\n${l.qrText}` };
  },
});

defineTool({
  name: 'discord_login_status', category: 'account', noAuth: true, readOnly: true,
  description: 'Check (or wait for) the QR-code login started with discord_login.',
  shape: { wait: z.boolean().optional().describe('Wait up to ~110s for the scan/confirmation'), login_id: z.string().optional() },
  handler: async (a) => {
    const l = getLogin(a.login_id);
    if (l && a.wait && (l.state === 'waiting_for_scan' || l.state === 'scanned')) await Promise.race([l.done, new Promise((r) => setTimeout(r, 110_000))]);
    return loginView(l);
  },
});

defineTool({
  name: 'discord_login_token', category: 'account', noAuth: true,
  description: 'Log in with a token you already have (user token, or "Bot <token>" / type=bot for a bot). Verifies it and saves it locally.',
  shape: { token: z.string().describe('Discord token'), type: z.enum(['user', 'bot']).optional().describe('Token type (default user; "Bot " prefix implies bot)') },
  handler: async (a) => {
    const t = parseToken(a.token, a.type);
    const u = await rest.get('/users/@me', undefined, { account: t });
    saveAccount({ ...t, user: { id: u.id, username: u.username, global_name: u.global_name } });
    gateway.close(); gateway.status = 'idle'; startGatewayInBackground();
    return { ok: true, logged_in_as: userName(u), type: t.type, saved_to: ACCOUNT_FILE };
  },
});

defineTool({
  name: 'discord_logout', category: 'account', noAuth: true, destructive: true,
  description: 'Forget the saved login on this machine. With revoke=true also invalidates the token at Discord (logs this session out everywhere it is used).',
  shape: { revoke: z.boolean().optional() },
  handler: async (a) => {
    if (a.revoke && currentAccount()) { try { await rest.post('/auth/logout', { provider: null, voip_provider: null }); } catch { /* ignore */ } }
    gateway.close();
    return { removed: clearAccount(), note: tokenFromEnv() ? 'DISCORD_TOKEN is set in the environment; remove it from the MCP config too.' : undefined };
  },
});

defineTool({
  name: 'whoami', category: 'account', readOnly: true,
  description: 'Who is logged in, account type (user/bot), and live connection status (gateway, servers, DMs cached). Start here.',
  shape: {},
  handler: async () => {
    const acc = currentAccount();
    if (!acc) return { logged_in: false, next: 'Call discord_login (QR code) or discord_login_token.' };
    const u = await rest.get('/users/@me');
    return {
      logged_in: true, account_type: acc.type, user: { id: u.id, name: userName(u), email: u.email, phone: u.phone, mfa: u.mfa_enabled, verified: u.verified, nitro: u.premium_type || undefined, locale: u.locale },
      gateway: settings.gateway ? { status: gateway.status, error: gateway.error, session_id: gateway.sessionId, servers: gateway.guilds.size, channels_cached: gateway.channels.size, connected_since: gateway.connectedAt ? new Date(gateway.connectedAt).toISOString() : undefined } : 'off',
      client_build: buildNumber(),
    };
  },
});

defineTool({
  name: 'reconnect_gateway', category: 'account',
  description: 'Reconnect the live gateway connection (use if live tools say the gateway is not ready).',
  shape: {},
  handler: async () => {
    gateway.close(); gateway.status = 'idle';
    await gateway.ensure(45_000);
    return { status: gateway.status, servers: gateway.guilds.size };
  },
});
