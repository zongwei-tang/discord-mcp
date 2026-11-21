import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.1.0';

const env = process.env;

/** Where the saved login and caches live (override with DISCORD_MCP_HOME). */
export const HOME = env.DISCORD_MCP_HOME || path.join(os.homedir(), '.discord-mcp');
export const ACCOUNT_FILE = path.join(HOME, 'account.json');
export const DOWNLOAD_DIR = env.DISCORD_DOWNLOAD_DIR || path.join(HOME, 'downloads');

export const API_BASE = (env.DISCORD_API_BASE || 'https://discord.com/api/v9').replace(/\/$/, '');
export const WEB_BASE = env.DISCORD_WEB_BASE || 'https://discord.com';
export const GATEWAY_URL = env.DISCORD_GATEWAY_URL || 'wss://gateway.discord.gg';
export const REMOTE_AUTH_URL = env.DISCORD_REMOTE_AUTH_URL || 'wss://remote-auth-gateway.discord.gg/?v=2';

export const settings = {
  /** "on" (default): keep a live gateway connection (needed for status, voice, slash commands, live events, unread counts). */
  gateway: (env.DISCORD_GATEWAY || 'on').toLowerCase() !== 'off',
  /** Only register read-only tools. */
  readOnly: /^(1|true|yes)$/i.test(env.DISCORD_READ_ONLY || ''),
  /** Comma-separated list of tool categories to expose (default: all). */
  toolsets: (env.DISCORD_TOOLSETS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** Extra tool names to hide. */
  disabledTools: new Set((env.DISCORD_DISABLED_TOOLS || '').split(',').map((s) => s.trim()).filter(Boolean)),
  locale: env.DISCORD_LOCALE || 'en-US',
  timezone: env.DISCORD_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  /** Override the Chrome version the client pretends to be. */
  chromeVersion: env.DISCORD_CHROME_VERSION || '142.0.0.0',
  maxOutputChars: Number(env.DISCORD_MAX_OUTPUT_CHARS || 60000),
};

export type TokenType = 'user' | 'bot';

export interface SavedAccount {
  token: string;
  type: TokenType;
  user?: { id: string; username: string; global_name?: string | null };
  savedAt?: string;
}

function readAccount(): SavedAccount | undefined {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')) as SavedAccount;
  } catch {
    return undefined;
  }
}

/** Normalise a pasted token: strip quotes, "Bot " prefix, whitespace. */
export function parseToken(raw: string, hint?: TokenType): { token: string; type: TokenType } {
  let t = raw.trim().replace(/^["']|["']$/g, '').trim();
  let type: TokenType = hint ?? 'user';
  if (/^bot\s+/i.test(t)) { t = t.replace(/^bot\s+/i, ''); type = 'bot'; }
  return { token: t, type };
}

/** Current credentials: DISCORD_TOKEN env wins, otherwise the saved login. */
export function currentAccount(): SavedAccount | undefined {
  if (env.DISCORD_TOKEN) {
    const hint = (env.DISCORD_TOKEN_TYPE || '').toLowerCase() === 'bot' ? 'bot' : undefined;
    return parseToken(env.DISCORD_TOKEN, hint);
  }
  return readAccount();
}

export function saveAccount(acc: SavedAccount) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify({ ...acc, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

export function clearAccount(): boolean {
  try { fs.unlinkSync(ACCOUNT_FILE); return true; } catch { return false; }
}

export function tokenFromEnv(): boolean {
  return !!env.DISCORD_TOKEN;
}
