/* One-intent shortcuts over the generic endpoints (moderation, notifications, server creation) + raw API access. */
import { fmtMember } from '../../discord/format.js';
import { gateway } from '../../discord/gateway.js';
import { rest, toDataUri } from '../../discord/rest.js';
import { inviteCode, permissionBits } from '../../discord/util.js';
import { filesParam } from '../spec.js';
import { defineTool, z } from '../registry.js';
import { channelRef, getChannel } from './common.js';

const member = { guild_id: z.string(), user_id: z.string(), reason: z.string().optional().describe('Audit log reason') };
const patchMember = (a: any, body: any) => rest.patch(`/guilds/${a.guild_id}/members/${a.user_id}`, body, { reason: a.reason }).then((m) => fmtMember(m, a.guild_id));

defineTool({
  name: 'timeout_member', category: 'moderation', destructive: true,
  description: 'Time out a member (they cannot chat or join voice) for N minutes (max 40320 = 28 days).',
  shape: { ...member, minutes: z.number().describe('Duration in minutes') },
  handler: (a) => patchMember(a, { communication_disabled_until: new Date(Date.now() + a.minutes * 60_000).toISOString() }),
});
defineTool({
  name: 'remove_timeout', category: 'moderation',
  description: 'Remove a member\'s timeout.',
  shape: member,
  handler: (a) => patchMember(a, { communication_disabled_until: null }),
});
defineTool({
  name: 'set_member_nickname', category: 'members',
  description: 'Change a member\'s server nickname (empty resets). For yourself use set_my_nickname.',
  shape: { ...member, nick: z.string() },
  handler: (a) => patchMember(a, { nick: a.nick || null }),
});
defineTool({
  name: 'set_member_roles', category: 'roles',
  description: 'Replace a member\'s whole role list.',
  shape: { ...member, role_ids: z.array(z.string()) },
  handler: (a) => patchMember(a, { roles: a.role_ids }),
});
defineTool({
  name: 'move_member_to_voice', category: 'voice',
  description: 'Move a member to another voice channel (needs Move Members).',
  shape: { ...member, channel_id: z.string() },
  handler: (a) => patchMember(a, { channel_id: a.channel_id }),
});
defineTool({
  name: 'disconnect_member_from_voice', category: 'voice', destructive: true,
  description: 'Disconnect a member from voice.',
  shape: member,
  handler: (a) => patchMember(a, { channel_id: null }),
});
defineTool({
  name: 'server_mute_member', category: 'voice',
  description: 'Server-mute or unmute a member in voice.',
  shape: { ...member, mute: z.boolean().describe('true = mute, false = unmute') },
  handler: (a) => patchMember(a, { mute: a.mute }),
});
defineTool({
  name: 'server_deafen_member', category: 'voice',
  description: 'Server-deafen or undeafen a member in voice.',
  shape: { ...member, deaf: z.boolean() },
  handler: (a) => patchMember(a, { deaf: a.deaf }),
});
defineTool({
  name: 'set_my_nickname', category: 'members',
  description: 'Change your own nickname in a server (empty resets).',
  shape: { guild_id: z.string(), nick: z.string() },
  handler: async (a) => fmtMember(await rest.patch(`/guilds/${a.guild_id}/members/@me`, { nick: a.nick || null }), a.guild_id),
});

async function guildSettingsPatch(guildId: string, body: any) { return rest.patch(`/users/@me/guilds/${guildId}/settings`, body); }
const muteCfg = (minutes?: number) => ({ end_time: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null, selected_time_window: minutes ? minutes * 60 : -1 });

defineTool({
  name: 'mute_server', category: 'notifications',
  description: 'Mute a server\'s notifications (optionally for N minutes).',
  shape: { guild_id: z.string(), minutes: z.number().optional() },
  handler: async (a) => { await guildSettingsPatch(a.guild_id, { muted: true, mute_config: muteCfg(a.minutes) }); return { ok: true }; },
});
defineTool({
  name: 'unmute_server', category: 'notifications',
  description: 'Unmute a server.',
  shape: { guild_id: z.string() },
  handler: async (a) => { await guildSettingsPatch(a.guild_id, { muted: false }); return { ok: true }; },
});
defineTool({
  name: 'set_server_notifications', category: 'notifications',
  description: 'Choose which messages notify you in a server: all, mentions or nothing; optionally suppress @everyone / role pings.',
  shape: { guild_id: z.string(), level: z.enum(['all', 'mentions', 'nothing']), suppress_everyone: z.boolean().optional(), suppress_roles: z.boolean().optional() },
  handler: async (a) => {
    await guildSettingsPatch(a.guild_id, { message_notifications: { all: 0, mentions: 1, nothing: 2 }[a.level as 'all'], suppress_everyone: a.suppress_everyone, suppress_roles: a.suppress_roles });
    return { ok: true };
  },
});
for (const mute of [true, false]) {
  defineTool({
    name: mute ? 'mute_channel' : 'unmute_channel', category: 'notifications',
    description: mute ? 'Mute a channel or DM (optionally for N minutes).' : 'Unmute a channel or DM.',
    shape: mute ? { channel_id: z.string(), minutes: z.number().optional() } : { channel_id: z.string() },
    handler: async (a) => {
      const ch = await getChannel(channelRef(a.channel_id).channel_id);
      const over: any = { muted: mute };
      if (mute) over.mute_config = muteCfg(a.minutes);
      await guildSettingsPatch(ch.guild_id ?? '@me', { channel_overrides: { [ch.id]: over } });
      return { ok: true };
    },
  });
}

defineTool({
  name: 'create_server', category: 'guilds',
  description: 'Create a new server (you become the owner). Optionally from a template code.',
  shape: { name: z.string(), icon: z.string().optional().describe('Icon: local path, URL or data URI'), template_code: z.string().optional().describe('Server template code (discord.new/<code>)') },
  handler: async (a) => {
    const icon = a.icon ? await toDataUri(a.icon) : undefined;
    if (a.template_code) return rest.post(`/guilds/templates/${inviteCode(a.template_code)}`, { name: a.name, icon });
    return rest.post('/guilds', { name: a.name, icon, channels: [], system_channel_id: null, guild_template_code: '2TffvPucqHkN' });
  },
});

defineTool({
  name: 'join_server', category: 'guilds',
  description: 'Join a server with an invite link or code (same as clicking an invite). New accounts may be asked for a captcha.',
  shape: { invite: z.string().describe('discord.gg/xyz link or code') },
  handler: async (a) => {
    const code = inviteCode(a.invite);
    const r = await rest.post(`/invites/${code}`, { session_id: gateway.sessionId ?? null });
    return { joined: r.guild?.name ?? r.channel?.name, guild_id: r.guild?.id ?? r.guild_id, channel_id: r.channel?.id, new_member: r.new_member };
  },
});

defineTool({
  name: 'create_invite', category: 'invites',
  description: 'Create an invite link to a channel (defaults: 24h, unlimited uses).',
  shape: { channel_id: z.string(), max_age_seconds: z.number().optional().describe('0 = never expires'), max_uses: z.number().optional(), temporary: z.boolean().optional(), unique: z.boolean().optional() },
  handler: async (a) => {
    const r = await rest.post(`/channels/${a.channel_id}/invites`, { max_age: a.max_age_seconds ?? 86400, max_uses: a.max_uses ?? 0, temporary: a.temporary, unique: a.unique });
    return { url: `https://discord.gg/${r.code}`, code: r.code, expires_at: r.expires_at };
  },
});

defineTool({
  name: 'set_channel_permission', category: 'channels',
  description: 'Allow/deny permissions for a role or member on a channel using names (e.g. allow ["VIEW_CHANNEL"], deny ["SEND_MESSAGES"]). Lock a channel: deny SEND_MESSAGES for @everyone (role id = server id).',
  shape: {
    channel_id: z.string(), target_id: z.string().describe('Role ID (server ID = @everyone) or user ID'), target_type: z.enum(['role', 'member']),
    allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional(), reason: z.string().optional(),
  },
  handler: async (a) => rest.put(`/channels/${a.channel_id}/permissions/${a.target_id}`, { type: a.target_type === 'role' ? 0 : 1, allow: permissionBits(a.allow ?? []) ?? '0', deny: permissionBits(a.deny ?? []) ?? '0' }, { reason: a.reason }),
});

const ANALYTICS = [
  'growth-activation/overview', 'growth-activation/joins', 'growth-activation/joins-by-invite-link', 'growth-activation/joins-by-referrer', 'growth-activation/joins-by-source',
  'growth-activation/leavers', 'growth-activation/activation', 'growth-activation/retention', 'growth-activation/membership',
  'engagement/base', 'engagement/overview', 'engagement/muters', 'engagement/pruneable-members', 'engagement/text-channels', 'engagement/voice-channels',
  'audience/new-members-by-discord-tenure', 'audience/participators-by-guild-tenure', 'audience/participators-by-platform', 'audience/participators-by-reg-country',
  'channel-following/overview', 'channel-following/announcements-by-channel', 'channel-following/reach', 'channel-following/following-guild-size-by-channel',
  'welcome-screen/funnel',
] as const;

defineTool({
  name: 'get_server_insights', category: 'guilds', readOnly: true,
  description: 'Server Insights analytics (Community servers, needs View Server Insights): growth, joins, leavers, retention, engagement, channel stats, audience.',
  shape: {
    guild_id: z.string(), report: z.enum(ANALYTICS), start: z.string().optional().describe('ISO8601 start'), end: z.string().optional().describe('ISO8601 end'),
    interval: z.number().optional().describe('1 day, 2 week, 3 month'),
  },
  handler: async (a) => rest.get(`/guilds/${a.guild_id}/analytics/${a.report}`, { start: a.start, end: a.end, interval: a.interval }),
});

defineTool({
  name: 'discord_api_request', category: 'misc',
  description: 'Escape hatch: call any Discord HTTP API route as your account (path relative to /api/v9, e.g. "/users/@me/billing/subscriptions"). Use when no dedicated tool exists.',
  shape: {
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: z.string(),
    query: z.record(z.string(), z.any()).optional(), body: z.any().optional(), files: filesParam, reason: z.string().optional(),
  },
  handler: async (a) => rest.request(a.method, a.path.startsWith('/') ? a.path : `/${a.path}`, { query: a.query, body: a.body, files: a.files, reason: a.reason }),
});
