/* Finding your way around: servers, channel trees, DMs, friends, unread, permissions. */
import { CHANNEL_TYPES, RELATIONSHIP_TYPES, channelLabel, fmtChannel, fmtUser, userName } from '../../discord/format.js';
import { gateway } from '../../discord/gateway.js';
import { rest } from '../../discord/rest.js';
import { cmpId, permissionNames, snowflakeAt, snowflakeTime } from '../../discord/util.js';
import { defineTool, z } from '../registry.js';
import { channelRef, dmChannel, gatewayReady, getChannel } from './common.js';

defineTool({
  name: 'list_guilds', category: 'guilds', readOnly: true,
  description: 'List the servers you are in (name, id, member counts, owner, unread/mention counts when live).',
  shape: {},
  handler: async () => {
    const list: any[] = await rest.get('/users/@me/guilds', { with_counts: true });
    return list.map((g) => {
      let unread = 0, mentions = 0;
      if (gatewayReady()) for (const c of gateway.channels.values()) {
        if (c.guild_id !== g.id || ![0, 5, 15, 16].includes(c.type)) continue;
        const r = gateway.readStates.get(c.id);
        mentions += r?.mention_count || 0;
        if (gateway.unread(c) && gateway.canView(c) && !gateway.isMuted(c)) unread++;
      }
      return { id: g.id, name: g.name, owner: g.owner || undefined, members: g.approximate_member_count, online: g.approximate_presence_count, unread_channels: unread || undefined, mentions: mentions || undefined };
    });
  },
});

async function guildChannels(guildId: string): Promise<any[]> {
  if (gatewayReady() && gateway.guilds.has(guildId)) return [...gateway.channels.values()].filter((c) => c.guild_id === guildId && ![10, 11, 12].includes(c.type));
  return (await rest.get(`/guilds/${guildId}/channels`)).map((c: any) => ({ ...c, guild_id: guildId }));
}

defineTool({
  name: 'get_channel_tree', category: 'channels', readOnly: true,
  description: 'Show a server\'s channels as a tree (categories → channels) with types, topics and unread markers; hides channels you cannot see.',
  shape: { guild_id: z.string(), include_hidden: z.boolean().optional().describe('Also list channels you lack View Channel on'), include_threads: z.boolean().optional().describe('Add active threads under their channels') },
  handler: async (a) => {
    let chans = await guildChannels(a.guild_id);
    if (!a.include_hidden && gatewayReady()) chans = chans.filter((c) => gateway.canView(c));
    const threads = a.include_threads ? (await rest.get(`/guilds/${a.guild_id}/threads/active`).catch(() => ({ threads: [] }))).threads : [];
    const node = (c: any) => {
      const r = gateway.readStates.get(c.id);
      return {
        id: c.id, name: c.name, type: CHANNEL_TYPES[c.type] ?? c.type, topic: c.topic ? c.topic.slice(0, 120) : undefined, nsfw: c.nsfw || undefined,
        unread: gatewayReady() && gateway.unread(c) ? true : undefined, mentions: r?.mention_count || undefined, muted: gatewayReady() && gateway.isMuted(c) ? true : undefined,
        voice: c.type === 2 || c.type === 13 ? gateway.guilds.get(a.guild_id)?.voice_states.filter((v: any) => v.channel_id === c.id).map((v: any) => gateway.users.get(v.user_id)?.username ?? v.member?.user?.username ?? v.user_id) : undefined,
        threads: threads.filter((t: any) => t.parent_id === c.id).map((t: any) => ({ id: t.id, name: t.name, messages: t.message_count })),
      };
    };
    const sort = (x: any, y: any) => (x.position ?? 0) - (y.position ?? 0) || cmpId(x.id, y.id);
    const cats = chans.filter((c) => c.type === 4).sort(sort);
    const top = chans.filter((c) => c.type !== 4 && !c.parent_id).sort(sort).map(node);
    return {
      guild: gateway.guilds.get(a.guild_id)?.name, guild_id: a.guild_id,
      uncategorized: top,
      categories: cats.map((cat) => ({ id: cat.id, category: cat.name, channels: chans.filter((c) => c.parent_id === cat.id).sort(sort).map(node) })),
    };
  },
});

defineTool({
  name: 'list_dms', category: 'dms', readOnly: true,
  description: 'List your DMs and group DMs, most recent first, with unread markers.',
  shape: { limit: z.number().optional().describe('Default 50'), unread_only: z.boolean().optional() },
  handler: async (a) => {
    let list: any[] = gatewayReady() ? [...gateway.channels.values()].filter((c) => c.type === 1 || c.type === 3) : await rest.get('/users/@me/channels');
    list.sort((x, y) => cmpId(y.last_message_id, x.last_message_id));
    if (a.unread_only) list = list.filter((c) => gateway.unread(c));
    return list.slice(0, a.limit ?? 50).map((c) => ({
      id: c.id, label: channelLabel(c), type: CHANNEL_TYPES[c.type], users: c.recipients?.map((u: any) => fmtUser(u)),
      last_activity: snowflakeTime(c.last_message_id)?.toISOString(), unread: gatewayReady() && gateway.unread(c) ? true : undefined,
      is_message_request: c.is_message_request || undefined,
    }));
  },
});

defineTool({
  name: 'open_dm', category: 'dms',
  description: 'Open (or get) the DM channel with a user; returns its channel ID.',
  shape: { user_id: z.string() },
  handler: async (a) => ({ channel_id: await dmChannel(a.user_id) }),
});

defineTool({
  name: 'create_group_dm', category: 'dms',
  description: 'Create a group DM with friends (up to 9 others).',
  shape: { user_ids: z.array(z.string()), name: z.string().optional() },
  handler: async (a) => {
    const ch = await rest.post('/users/@me/channels', { recipients: a.user_ids });
    if (a.name) await rest.patch(`/channels/${ch.id}`, { name: a.name });
    return fmtChannel({ ...ch, name: a.name ?? ch.name });
  },
});

defineTool({
  name: 'find_channels', category: 'channels', readOnly: true,
  description: 'Find channels by name across all your servers (and DMs by person name). Needs the live connection.',
  shape: { query: z.string(), guild_id: z.string().optional(), limit: z.number().optional() },
  handler: async (a) => {
    await gateway.ensure();
    const q = a.query.toLowerCase().replace(/^#/, '');
    const out = [];
    for (const c of gateway.channels.values()) {
      if (a.guild_id && c.guild_id !== a.guild_id) continue;
      const hay = [c.name, ...(c.recipients || []).flatMap((u: any) => [u.username, u.global_name])].filter(Boolean).join(' ').toLowerCase();
      if (hay.includes(q) && gateway.canView(c)) out.push(fmtChannel(c));
    }
    out.sort((x, y) => (x.name?.toLowerCase() === q ? -1 : 0) - (y.name?.toLowerCase() === q ? -1 : 0));
    return out.slice(0, a.limit ?? 25);
  },
});

defineTool({
  name: 'find_users', category: 'users', readOnly: true,
  description: 'Find people by name among your friends, DM contacts and (with guild_id) a server\'s members.',
  shape: { query: z.string(), guild_id: z.string().optional(), limit: z.number().optional() },
  handler: async (a) => {
    const q = a.query.toLowerCase().replace(/^@/, '');
    const seen = new Map<string, any>();
    const consider = (u: any, where: string) => {
      if (!u?.id || seen.has(u.id)) return;
      const hay = `${u.username} ${u.global_name ?? ''}`.toLowerCase();
      if (hay.includes(q)) seen.set(u.id, { ...fmtUser(u), found_in: where });
    };
    const rels: any[] = await rest.get('/users/@me/relationships').catch(() => []);
    for (const r of rels) consider(r.user, RELATIONSHIP_TYPES[r.type] ?? 'relationship');
    for (const c of gateway.channels.values()) for (const u of c.recipients || []) consider(u, 'dm');
    for (const u of gateway.users.values()) consider(u, 'cache');
    if (a.guild_id) {
      try {
        await gateway.ensure();
        const r = await gateway.requestMembers(a.guild_id, { query: a.query, limit: 50 });
        for (const m of r.members) consider(m.user, 'server member');
      } catch {
        const ms: any[] = await rest.get(`/guilds/${a.guild_id}/members/search`, { query: a.query, limit: 50 }).catch(() => []);
        for (const m of ms) consider(m.user, 'server member');
      }
    }
    return [...seen.values()].slice(0, a.limit ?? 25);
  },
});

defineTool({
  name: 'list_friends', category: 'friends', readOnly: true,
  description: 'List friends, blocked users and pending friend requests in readable form.',
  shape: { type: z.enum(['friend', 'blocked', 'incoming_request', 'outgoing_request', 'all']).optional().describe('Default all') },
  handler: async (a) => {
    const rels: any[] = await rest.get('/users/@me/relationships');
    return rels.map((r) => ({ id: r.id, type: RELATIONSHIP_TYPES[r.type] ?? r.type, name: userName(r.user), nickname: r.nickname || undefined, since: r.since }))
      .filter((r) => !a.type || a.type === 'all' || r.type === a.type);
  },
});

defineTool({
  name: 'add_friend', category: 'friends',
  description: 'Send a friend request by username (e.g. "jane" or "jane#1234" for old tags).',
  shape: { username: z.string() },
  handler: async (a) => {
    const [username, discriminator] = a.username.replace(/^@/, '').split('#');
    return rest.post('/users/@me/relationships', { username, discriminator: discriminator ?? null });
  },
});

defineTool({
  name: 'accept_friend_request', category: 'friends',
  description: 'Accept an incoming friend request (or send one by user ID).',
  shape: { user_id: z.string() },
  handler: async (a) => rest.put(`/users/@me/relationships/${a.user_id}`, {}),
});

defineTool({
  name: 'block_user', category: 'friends', destructive: true,
  description: 'Block a user.',
  shape: { user_id: z.string() },
  handler: async (a) => rest.put(`/users/@me/relationships/${a.user_id}`, { type: 2 }),
});

for (const [name, desc] of [['unblock_user', 'Unblock a user.'], ['remove_friend', 'Remove a friend (or cancel/decline a friend request).']] as const) {
  defineTool({
    name, category: 'friends', destructive: name === 'remove_friend',
    description: desc,
    shape: { user_id: z.string() },
    handler: async (a) => rest.delete(`/users/@me/relationships/${a.user_id}`),
  });
}

defineTool({
  name: 'get_my_permissions', category: 'roles', readOnly: true,
  description: 'Your effective permissions in a server, or in a specific channel (computed from roles and overwrites).',
  shape: { guild_id: z.string(), channel_id: z.string().optional() },
  handler: async (a) => {
    await gateway.ensure();
    const p = gateway.permissions(a.guild_id, a.channel_id);
    if (p === undefined) throw new Error('Server not in cache (are you a member?)');
    return { bitfield: p.toString(), permissions: permissionNames(p) };
  },
});

defineTool({
  name: 'snowflake_info', category: 'misc', readOnly: true,
  description: 'Convert a Discord ID to its creation time, or a time to an ID (for before/after cursors).',
  shape: { id: z.string().optional(), time: z.string().optional().describe('ISO8601 time') },
  handler: async (a) => ({ id: a.id ?? (a.time ? snowflakeAt(a.time) : undefined), time: a.id ? snowflakeTime(a.id)?.toISOString() : a.time }),
});

// ------------------------------------------------------------- unread / read state
defineTool({
  name: 'list_unread', category: 'read_state', readOnly: true,
  description: 'What is unread right now: DMs with new messages, channels where you were mentioned, and (all=true) every unread unmuted channel. Needs the live connection.',
  shape: { all: z.boolean().optional().describe('Include every unread unmuted channel, not just DMs and mentions'), guild_id: z.string().optional() },
  handler: async (a) => {
    await gateway.ensure();
    const dms = [], mentions = [], unread = [];
    for (const c of gateway.channels.values()) {
      if (a.guild_id && c.guild_id !== a.guild_id) continue;
      const r = gateway.readStates.get(c.id);
      const isUnread = gateway.unread(c);
      if (c.type === 1 || c.type === 3) { if (isUnread && !a.guild_id) dms.push({ id: c.id, label: channelLabel(c), mentions: r?.mention_count || undefined, last: snowflakeTime(c.last_message_id)?.toISOString() }); continue; }
      if (!gateway.canView(c)) continue;
      const entry = { id: c.id, channel: `#${c.name}`, guild: gateway.guilds.get(c.guild_id)?.name, guild_id: c.guild_id, mentions: r?.mention_count || undefined, last: snowflakeTime(c.last_message_id)?.toISOString() };
      if (r?.mention_count) mentions.push(entry);
      else if (a.all && isUnread && !gateway.isMuted(c)) unread.push(entry);
    }
    const byLast = (x: any, y: any) => (y.last ?? '').localeCompare(x.last ?? '');
    return { dms: dms.sort(byLast), mentions: mentions.sort(byLast), unread: a.all ? unread.sort(byLast).slice(0, 200) : undefined };
  },
});

defineTool({
  name: 'mark_read', category: 'read_state',
  description: 'Mark as read: one channel/DM (channel_id), a whole server (guild_id), or everything (all=true).',
  shape: { channel_id: z.string().optional(), guild_id: z.string().optional(), all: z.boolean().optional() },
  handler: async (a) => {
    if (a.channel_id) {
      const id = channelRef(a.channel_id).channel_id;
      let last = gateway.channels.get(id)?.last_message_id;
      if (!last) { const ms: any[] = await rest.get(`/channels/${id}/messages`, { limit: 1 }); last = ms[0]?.id; }
      if (!last) return { ok: true, note: 'Channel is empty' };
      await rest.post(`/channels/${id}/messages/${last}/ack`, { token: null, manual: true, mention_count: 0 });
      return { ok: true, marked: 1 };
    }
    if (!a.guild_id && !a.all) throw new Error('Give channel_id, guild_id or all=true');
    await gateway.ensure();
    const targets = [...gateway.channels.values()].filter((c) => (a.all || c.guild_id === a.guild_id) && gateway.unread(c) && gateway.canView(c));
    for (let i = 0; i < targets.length; i += 100) {
      await rest.post('/read-states/ack-bulk', { read_states: targets.slice(i, i + 100).map((c) => ({ channel_id: c.id, message_id: c.last_message_id, read_state_type: 0 })) });
    }
    return { ok: true, marked: targets.length };
  },
});

defineTool({
  name: 'get_channel_info', category: 'channels', readOnly: true,
  description: 'Readable info about a channel/thread/DM (type, server, topic, recipients, last activity).',
  shape: { channel_id: z.string() },
  handler: async (a) => fmtChannel(await getChannel(channelRef(a.channel_id).channel_id)),
});
