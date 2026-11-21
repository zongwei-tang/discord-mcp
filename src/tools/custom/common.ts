/* Shared helpers for hand-written tools. */
import { gateway } from '../../discord/gateway.js';
import { rest } from '../../discord/rest.js';
import { settings } from '../../config.js';
import { parseDiscordLink } from '../../discord/util.js';

export async function me(): Promise<any> {
  if (gateway.user) return gateway.user;
  return rest.get('/users/@me');
}

/** Channel object from cache or REST (with guild_id). */
export async function getChannel(id: string): Promise<any> {
  const c = gateway.channels.get(id);
  if (c) return c;
  const ch = await rest.get(`/channels/${id}`);
  if (settings.gateway && gateway.status === 'ready') gateway.channels.set(ch.id, ch);
  return ch;
}

/** Accept a channel ID or a discord.com/channels/... link. */
export function channelRef(v: string): { channel_id: string; message_id?: string; guild_id?: string } {
  if (/discord(?:app)?\.com\/channels\//.test(v)) {
    const l = parseDiscordLink(v);
    if (l.channel_id) return { channel_id: l.channel_id, message_id: l.message_id, guild_id: l.guild_id };
  }
  return { channel_id: v.trim().replace(/^<#(\d+)>$/, '$1') };
}

/** Open (or reuse) a DM channel with a user. */
export async function dmChannel(userId: string): Promise<string> {
  for (const c of gateway.channels.values()) {
    if (c.type === 1 && (c.recipients?.[0]?.id === userId || c.recipient_ids?.[0] === userId)) return c.id;
  }
  const ch = await rest.post('/users/@me/channels', { recipients: [userId] });
  return ch.id;
}

/** Fetch one message. User accounts can't use GET /messages/{id}; use around= instead. */
export async function fetchMessage(channelId: string, messageId: string): Promise<any> {
  const list: any[] = await rest.get(`/channels/${channelId}/messages`, { around: messageId, limit: 1 });
  const m = list.find((x) => x.id === messageId);
  if (m) return m;
  try { return await rest.get(`/channels/${channelId}/messages/${messageId}`); } catch { /* fallthrough */ }
  throw new Error(`Message ${messageId} not found in channel ${channelId}`);
}

export function gatewayReady(): boolean { return settings.gateway && gateway.status === 'ready'; }

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
