/* Real-time things that need the live gateway: presence, voice, events, waiting for replies, member lookup. */
import { fmtMember, fmtMessage, userName } from '../../discord/format.js';
import { gateway } from '../../discord/gateway.js';
import { rest } from '../../discord/rest.js';
import { prune } from '../../discord/util.js';
import { defineTool, z } from '../registry.js';
import { channelRef, getChannel } from './common.js';

const ACTIVITY_TYPES: Record<string, number> = { playing: 0, streaming: 1, listening: 2, watching: 3, custom: 4, competing: 5 };

function customStatusActivity() { return gateway.presence.activities.find((x) => x.type === 4); }

defineTool({
  name: 'set_status', category: 'presence',
  description: 'Set your online status: online, idle, dnd (Do Not Disturb) or invisible.',
  shape: { status: z.enum(['online', 'idle', 'dnd', 'invisible']) },
  handler: async (a) => {
    const notes: string[] = [];
    try { await rest.patch('/users/@me/settings', { status: a.status }); } catch (e) { notes.push(`settings: ${(e as Error).message}`); }
    try { await gateway.ensure(); gateway.updatePresence({ status: a.status, afk: a.status === 'idle' }); } catch (e) { notes.push(`gateway: ${(e as Error).message}`); }
    return { ok: notes.length < 2, status: a.status, notes: notes.length ? notes : undefined };
  },
});

defineTool({
  name: 'set_custom_status', category: 'presence',
  description: 'Set (or clear) your custom status text/emoji, optionally expiring after N minutes.',
  shape: {
    text: z.string().optional().describe('Status text; omit both text and emoji to clear'), emoji: z.string().optional().describe('Unicode emoji, or custom name:id'),
    expires_in_minutes: z.number().optional(),
  },
  handler: async (a) => {
    let cs: any = null;
    if (a.text || a.emoji) {
      const [ename, eid] = (a.emoji || '').replace(/^<a?:|>$/g, '').split(':');
      cs = { text: a.text ?? null, emoji_name: ename || null, emoji_id: eid || null, expires_at: a.expires_in_minutes ? new Date(Date.now() + a.expires_in_minutes * 60_000).toISOString() : null };
    }
    await rest.patch('/users/@me/settings', { custom_status: cs });
    try {
      await gateway.ensure(5000);
      const others = gateway.presence.activities.filter((x) => x.type !== 4);
      const act = cs ? [{ type: 4, name: 'Custom Status', state: cs.text ?? undefined, emoji: cs.emoji_name ? { name: cs.emoji_name, id: cs.emoji_id ?? undefined } : undefined }] : [];
      gateway.updatePresence({ activities: [...act, ...others] });
    } catch { /* settings already applied */ }
    return { ok: true, custom_status: cs };
  },
});

defineTool({
  name: 'set_activity', category: 'presence',
  description: 'Show an activity on your profile: Playing / Listening to / Watching / Competing in / Streaming <name>. Lasts while this MCP is connected.',
  shape: {
    name: z.string().describe('e.g. a game name'), type: z.enum(['playing', 'streaming', 'listening', 'watching', 'competing']).optional().describe('Default playing'),
    details: z.string().optional(), state: z.string().optional(), url: z.string().optional().describe('Stream URL (twitch/youtube) for streaming'),
    application_id: z.string().optional(), start_now: z.boolean().optional().describe('Show elapsed time from now'),
  },
  handler: async (a) => {
    await gateway.ensure();
    const act: any = { name: a.name, type: ACTIVITY_TYPES[a.type ?? 'playing'], details: a.details, state: a.state, url: a.url, application_id: a.application_id };
    if (a.start_now) act.timestamps = { start: Date.now() };
    const cs = customStatusActivity();
    gateway.updatePresence({ activities: [...(cs ? [cs] : []), prune(act)] });
    return { ok: true, activities: gateway.presence.activities };
  },
});

defineTool({
  name: 'clear_activity', category: 'presence',
  description: 'Remove the activity set with set_activity (keeps your custom status).',
  shape: {},
  handler: async () => {
    await gateway.ensure();
    const cs = customStatusActivity();
    gateway.updatePresence({ activities: cs ? [cs] : [] });
    return { ok: true };
  },
});

defineTool({
  name: 'join_voice_channel', category: 'voice',
  description: 'Join a voice/stage channel, or start/join a DM call (pass the DM channel_id; ring=true rings them). Note: you appear connected but no audio is streamed.',
  shape: {
    channel_id: z.string(), self_mute: z.boolean().optional(), self_deaf: z.boolean().optional(), self_video: z.boolean().optional(),
    ring: z.boolean().optional().describe('DM/group calls: ring the other people'),
  },
  handler: async (a) => {
    await gateway.ensure();
    const ch = await getChannel(channelRef(a.channel_id).channel_id);
    const guildId = ch.guild_id ?? null;
    gateway.voiceStateUpdate(guildId, ch.id, a);
    const ev = await gateway.waitFor('VOICE_STATE_UPDATE', (d) => d.user_id === gateway.user?.id && d.channel_id === ch.id, 8000);
    if (a.ring && !guildId) await rest.post(`/channels/${ch.id}/call/ring`, { recipients: null }).catch(() => undefined);
    return { ok: !!ev, channel: ch.name ?? ch.id, guild_id: guildId, note: ev ? undefined : 'No confirmation from Discord yet (permissions? channel full?).' };
  },
});

defineTool({
  name: 'leave_voice_channel', category: 'voice',
  description: 'Disconnect from voice (in a server: pass guild_id; omit for DM calls).',
  shape: { guild_id: z.string().optional() },
  handler: async (a) => {
    await gateway.ensure();
    gateway.voiceStateUpdate(a.guild_id ?? null, null);
    return { ok: true };
  },
});

defineTool({
  name: 'set_voice_mute', category: 'voice',
  description: 'Mute/deafen/camera yourself in the voice channel you are in.',
  shape: { guild_id: z.string().optional().describe('Server (omit for DM calls)'), self_mute: z.boolean().optional(), self_deaf: z.boolean().optional(), self_video: z.boolean().optional() },
  handler: async (a) => {
    await gateway.ensure();
    const cur = gateway.voice.get(a.guild_id ?? '@me');
    if (!cur) throw new Error('You are not in a voice channel there.');
    gateway.voiceStateUpdate(a.guild_id ?? null, cur.channel_id, { self_mute: a.self_mute ?? cur.self_mute, self_deaf: a.self_deaf ?? cur.self_deaf, self_video: a.self_video ?? cur.self_video });
    return { ok: true };
  },
});

defineTool({
  name: 'list_voice_members', category: 'voice', readOnly: true,
  description: 'Who is in voice channels of a server right now (optionally one channel), with mute/deafen/stream flags. Also shows where you are connected.',
  shape: { guild_id: z.string(), channel_id: z.string().optional() },
  handler: async (a) => {
    await gateway.ensure();
    const g = gateway.guilds.get(a.guild_id);
    if (!g) throw new Error('Server not in cache');
    const by: Record<string, any[]> = {};
    for (const v of g.voice_states) {
      if (a.channel_id && v.channel_id !== a.channel_id) continue;
      const u = v.member?.user ?? gateway.users.get(v.user_id);
      (by[gateway.channels.get(v.channel_id)?.name ?? v.channel_id] ??= []).push({
        user_id: v.user_id, name: u ? userName(u) : undefined, muted: v.self_mute || v.mute || undefined, deafened: v.self_deaf || v.deaf || undefined,
        streaming: v.self_stream || undefined, video: v.self_video || undefined,
      });
    }
    return { channels: by, you: [...gateway.voice.values()].map((v) => ({ guild_id: v.guild_id, channel_id: v.channel_id })) };
  },
});

defineTool({
  name: 'search_members', category: 'members', readOnly: true,
  description: 'Look up server members by name prefix (or by user_ids) through the live connection — works for normal user accounts.',
  shape: {
    guild_id: z.string(), query: z.string().optional().describe('Username/nickname prefix ("" lists all, needs moderator permissions)'),
    user_ids: z.array(z.string()).optional(), limit: z.number().optional().describe('Max 100'), presences: z.boolean().optional(),
  },
  handler: async (a) => {
    await gateway.ensure();
    const r = await gateway.requestMembers(a.guild_id, { query: a.query, limit: a.limit, user_ids: a.user_ids, presences: a.presences });
    const pres = new Map(r.presences.map((p: any) => [p.user?.id, p.status]));
    return { count: r.members.length, members: r.members.map((m) => ({ ...fmtMember(m, a.guild_id), status: pres.get(m.user?.id) })), not_found: r.not_found.length ? r.not_found : undefined };
  },
});

function summarize(e: { seq: number; t: string; at: number; d: any }) {
  const d = e.d;
  let data: any;
  if (e.t.startsWith('MESSAGE_CREATE') || e.t === 'MESSAGE_UPDATE') data = { ...fmtMessage(d), channel_id: d.channel_id, guild_id: d.guild_id };
  else if (e.t.startsWith('MESSAGE_REACTION')) data = { channel_id: d.channel_id, message_id: d.message_id, user_id: d.user_id, emoji: d.emoji?.name };
  else if (e.t === 'MESSAGE_DELETE') data = { channel_id: d.channel_id, message_id: d.id };
  else if (e.t === 'GUILD_CREATE') data = { id: d.id, name: d.properties?.name ?? d.name };
  else { const s = JSON.stringify(d); data = s.length > 1500 ? `${s.slice(0, 1500)}…` : d; }
  return { seq: e.seq, type: e.t, at: new Date(e.at).toISOString(), data };
}

defineTool({
  name: 'get_events', category: 'live', readOnly: true,
  description: 'Recent live events received since connecting (new/edited/deleted messages, reactions, friend requests, calls, joins…). Use since_seq to poll for only new ones.',
  shape: {
    types: z.array(z.string()).optional().describe('e.g. ["MESSAGE_CREATE","MESSAGE_REACTION_ADD","RELATIONSHIP_ADD","CALL_CREATE"]'),
    channel_id: z.string().optional(), guild_id: z.string().optional().describe('Use "@me" for DMs only'),
    since_seq: z.number().optional(), limit: z.number().optional().describe('Default 50'),
    exclude_mine: z.boolean().optional().describe('Skip your own messages'),
  },
  handler: async (a) => {
    await gateway.ensure();
    const set = a.types?.length ? new Set(a.types.map((t: string) => t.toUpperCase())) : undefined;
    const evs = gateway.events.filter((e) => (!a.since_seq || e.seq > a.since_seq) && (!set || set.has(e.t))
      && (!a.channel_id || e.d?.channel_id === a.channel_id)
      && (!a.guild_id || (a.guild_id === '@me' ? !e.d?.guild_id : e.d?.guild_id === a.guild_id))
      && (!a.exclude_mine || e.d?.author?.id !== gateway.user?.id));
    return { latest_seq: gateway.latestEventSeq(), events: evs.slice(-(a.limit ?? 50)).map(summarize) };
  },
});

defineTool({
  name: 'wait_for_message', category: 'live', readOnly: true,
  description: 'Wait for the next incoming message (e.g. a reply) matching filters, up to timeout_seconds.',
  shape: {
    channel_id: z.string().optional(), guild_id: z.string().optional().describe('"@me" = any DM'), author_id: z.string().optional(),
    contains: z.string().optional(), mentions_me: z.boolean().optional(), include_mine: z.boolean().optional(),
    timeout_seconds: z.number().optional().describe('Default 60, max 600'),
  },
  handler: async (a) => {
    await gateway.ensure();
    const me = gateway.user?.id;
    const r = await gateway.waitFor('MESSAGE_CREATE', (d) => (!a.channel_id || d.channel_id === channelRef(a.channel_id).channel_id)
      && (!a.guild_id || (a.guild_id === '@me' ? !d.guild_id : d.guild_id === a.guild_id))
      && (!a.author_id || d.author?.id === a.author_id) && (a.include_mine || d.author?.id !== me)
      && (!a.contains || d.content?.toLowerCase().includes(a.contains.toLowerCase()))
      && (!a.mentions_me || (d.mentions || []).some((u: any) => u.id === me)), Math.min(a.timeout_seconds ?? 60, 600) * 1000);
    return r ? { received: true, message: { ...fmtMessage(r.d), channel_id: r.d.channel_id, guild_id: r.d.guild_id } } : { received: false, note: 'Timed out' };
  },
});

defineTool({
  name: 'wait_for_event', category: 'live', readOnly: true,
  description: 'Wait for any gateway event type (e.g. MESSAGE_REACTION_ADD, RELATIONSHIP_ADD, CALL_CREATE, GUILD_MEMBER_ADD, VOICE_STATE_UPDATE).',
  shape: { types: z.array(z.string()), channel_id: z.string().optional(), guild_id: z.string().optional(), user_id: z.string().optional(), timeout_seconds: z.number().optional() },
  handler: async (a) => {
    await gateway.ensure();
    const r = await gateway.waitFor(a.types.map((t: string) => t.toUpperCase()), (d) => (!a.channel_id || d?.channel_id === a.channel_id)
      && (!a.guild_id || d?.guild_id === a.guild_id) && (!a.user_id || (d?.user_id ?? d?.author?.id ?? d?.user?.id) === a.user_id), Math.min(a.timeout_seconds ?? 60, 600) * 1000);
    return r ? summarize({ seq: gateway.latestEventSeq(), t: r.t, at: Date.now(), d: r.d }) : { received: false };
  },
});
