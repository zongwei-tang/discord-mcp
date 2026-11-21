/* Compact, human-readable shapes for messages, channels, users, guilds. */
import { gateway } from './gateway.js';
import { snowflakeTime } from './util.js';

export const CHANNEL_TYPES: Record<number, string> = {
  0: 'text', 1: 'dm', 2: 'voice', 3: 'group_dm', 4: 'category', 5: 'announcement', 10: 'announcement_thread', 11: 'thread',
  12: 'private_thread', 13: 'stage', 14: 'directory', 15: 'forum', 16: 'media',
};

const MESSAGE_TYPES: Record<number, string> = {
  1: 'recipient_add', 2: 'recipient_remove', 3: 'call', 4: 'channel_name_change', 5: 'channel_icon_change', 6: 'pin', 7: 'member_join',
  8: 'boost', 9: 'boost_tier_1', 10: 'boost_tier_2', 11: 'boost_tier_3', 12: 'channel_follow_add', 18: 'thread_created', 20: 'slash_command',
  21: 'thread_starter', 22: 'guild_invite_reminder', 23: 'context_menu_command', 24: 'automod_action', 25: 'role_subscription_purchase',
  27: 'stage_start', 28: 'stage_end', 29: 'stage_speaker', 31: 'stage_topic', 36: 'incident_alert_mode_enabled', 37: 'incident_alert_mode_disabled',
  44: 'purchase_notification', 46: 'poll_result',
};

export function userName(u: any): string {
  if (!u) return 'unknown';
  const handle = u.discriminator && u.discriminator !== '0' ? `${u.username}#${u.discriminator}` : u.username;
  const disp = u.global_name && u.global_name !== u.username ? `${u.global_name} (@${handle})` : `@${handle}`;
  return `${disp}${u.bot ? ' [bot]' : ''}`;
}

export function fmtUser(u: any) {
  if (!u) return undefined;
  return { id: u.id, name: userName(u), username: u.username, display_name: u.global_name || undefined, bot: u.bot || undefined };
}

function trim(s: string | undefined, n: number) {
  if (!s) return s;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function flattenComponents(cs: any[] | undefined, out: any[] = []): any[] {
  for (const c of cs || []) {
    if (c.components) flattenComponents(c.components, out);
    if (c.accessory) flattenComponents([c.accessory], out);
    if (c.type === 2) out.push({ kind: 'button', label: c.label ?? c.emoji?.name, custom_id: c.custom_id, url: c.url, style: c.style, disabled: c.disabled || undefined, sku_id: c.sku_id });
    else if ([3, 5, 6, 7, 8].includes(c.type)) out.push({
      kind: ({ 3: 'string_select', 5: 'user_select', 6: 'role_select', 7: 'mentionable_select', 8: 'channel_select' } as any)[c.type], component_type: c.type,
      custom_id: c.custom_id, placeholder: c.placeholder, min: c.min_values, max: c.max_values, disabled: c.disabled || undefined,
      options: c.options?.map((o: any) => ({ label: o.label, value: o.value, description: o.description, default: o.default || undefined })),
    });
    else if (c.type === 10 && c.content) out.push({ kind: 'text', content: trim(c.content, 1500) });
  }
  return out;
}

export function fmtMessage(m: any, opts: { full?: boolean } = {}): any {
  if (!m) return m;
  const out: any = {
    id: m.id,
    time: m.timestamp ?? snowflakeTime(m.id)?.toISOString(),
    author: m.author ? userName(m.author) : undefined,
    author_id: m.author?.id,
    content: m.content || undefined,
  };
  if (m.member?.nick) out.nick = m.member.nick;
  if (m.type && m.type !== 0 && m.type !== 19) out.type = MESSAGE_TYPES[m.type] ?? m.type;
  if (m.edited_timestamp) out.edited = m.edited_timestamp;
  if (m.pinned) out.pinned = true;
  if (m.message_reference?.message_id) {
    const forward = m.message_reference.type === 1;
    out[forward ? 'forwarded_from' : 'reply_to'] = m.message_reference.message_id;
    if (m.referenced_message && !forward) out.reply_preview = `${userName(m.referenced_message.author)}: ${trim(m.referenced_message.content, 120) ?? ''}`;
  }
  if (m.message_snapshots?.length) out.forwarded = m.message_snapshots.map((s: any) => fmtMessage({ ...s.message, id: undefined }, opts));
  if (m.attachments?.length) out.attachments = m.attachments.map((a: any) => ({ id: a.id, filename: a.filename, size: a.size, type: a.content_type, url: a.url, description: a.description, spoiler: a.filename?.startsWith('SPOILER_') || undefined }));
  if (m.embeds?.length) out.embeds = m.embeds.map((e: any) => ({
    type: e.type !== 'rich' ? e.type : undefined, title: e.title, url: e.url, author: e.author?.name,
    description: opts.full ? e.description : trim(e.description, 600), fields: e.fields?.map((f: any) => `${f.name}: ${opts.full ? f.value : trim(f.value, 300)}`),
    image: e.image?.url, thumbnail: opts.full ? e.thumbnail?.url : undefined, video: e.video?.url, footer: e.footer?.text, provider: e.provider?.name,
  }));
  if (m.sticker_items?.length) out.stickers = m.sticker_items.map((s: any) => `${s.name} (${s.id})`);
  if (m.reactions?.length) out.reactions = m.reactions.map((r: any) => `${r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name} ×${r.count}${r.me ? ' (you)' : ''}`);
  const comps = flattenComponents(m.components);
  if (comps.length) out.components = comps;
  if (m.poll) out.poll = {
    question: m.poll.question?.text, multiselect: m.poll.allow_multiselect || undefined, expiry: m.poll.expiry,
    answers: m.poll.answers?.map((a: any) => {
      const c = m.poll.results?.answer_counts?.find((x: any) => x.id === a.answer_id);
      return `${a.answer_id}. ${a.poll_media?.emoji?.name ? `${a.poll_media.emoji.name} ` : ''}${a.poll_media?.text ?? ''}${c ? ` — ${c.count}${c.me_voted ? ' (you)' : ''}` : ''}`;
    }),
    finalized: m.poll.results?.is_finalized || undefined,
  };
  if (m.thread) out.thread = { id: m.thread.id, name: m.thread.name, messages: m.thread.message_count };
  if (m.interaction_metadata || m.interaction) {
    const i = m.interaction_metadata ?? m.interaction;
    out.command = { name: i.name, by: i.user ? userName(i.user) : undefined };
  }
  if (m.call) out.call = { participants: m.call.participants?.length, ended: m.call.ended_timestamp };
  if (m.mentions?.length && opts.full) out.mentions = m.mentions.map((u: any) => userName(u));
  if (m.flags & 64) out.ephemeral = true;
  if (m.application_id) out.application_id = m.application_id;
  if (opts.full) { out.channel_id = m.channel_id; out.guild_id = m.guild_id; }
  return out;
}

export function channelLabel(c: any): string {
  if (!c) return 'unknown';
  if (c.type === 1) return `DM with ${c.recipients?.map(userName).join(', ') || c.recipient_ids?.join(',') || '?'}`;
  if (c.type === 3) return `Group DM ${c.name || c.recipients?.map((u: any) => u.global_name || u.username).join(', ')}`;
  return `#${c.name}`;
}

export function fmtChannel(c: any) {
  if (!c) return c;
  const g = c.guild_id ? gateway.guilds.get(c.guild_id) : undefined;
  return {
    id: c.id, name: c.name || undefined, label: channelLabel(c), type: CHANNEL_TYPES[c.type] ?? c.type, guild_id: c.guild_id, guild: g?.name,
    parent_id: c.parent_id || undefined, topic: trim(c.topic, 200), nsfw: c.nsfw || undefined, position: c.position,
    recipients: c.recipients?.map((u: any) => fmtUser(u)), last_message_id: c.last_message_id || undefined,
    last_activity: snowflakeTime(c.last_message_id)?.toISOString(),
  };
}

export function fmtMember(m: any, guildId?: string) {
  const g = guildId ? gateway.guilds.get(guildId) : undefined;
  return {
    id: m.user?.id ?? m.user_id, name: m.user ? userName(m.user) : undefined, nick: m.nick || undefined,
    roles: m.roles?.map((r: string) => g?.roles.get(r)?.name ?? r), joined_at: m.joined_at, timed_out_until: m.communication_disabled_until || undefined,
    pending: m.pending || undefined,
  };
}

export const RELATIONSHIP_TYPES: Record<number, string> = { 1: 'friend', 2: 'blocked', 3: 'incoming_request', 4: 'outgoing_request', 5: 'implicit', 6: 'suggestion' };
