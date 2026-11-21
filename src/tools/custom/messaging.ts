/* Sending, reading, searching and managing messages — the everyday chat actions. */
import fs from 'node:fs';
import path from 'node:path';
import { DOWNLOAD_DIR } from '../../config.js';
import { channelLabel, fmtMessage } from '../../discord/format.js';
import { gateway } from '../../discord/gateway.js';
import { loadFile, rest } from '../../discord/rest.js';
import { nonce, parseDiscordLink, snowflakeAt } from '../../discord/util.js';
import { filesParam } from '../spec.js';
import { defineTool, z } from '../registry.js';
import { channelRef, dmChannel, fetchMessage, getChannel, me, sleep } from './common.js';

const target = {
  channel_id: z.string().optional().describe('Channel/thread/DM ID or a discord.com/channels/… link'),
  user_id: z.string().optional().describe('Or: a user ID to DM (opens the DM for you)'),
};

async function resolveTarget(a: { channel_id?: string; user_id?: string }): Promise<string> {
  if (a.channel_id) return channelRef(a.channel_id).channel_id;
  if (a.user_id) return dmChannel(a.user_id);
  throw new Error('Give channel_id (or a link) or user_id');
}

async function send(channelId: string, a: any) {
  const body: any = {
    content: a.content, tts: a.tts || undefined, nonce: nonce(), sticker_ids: a.sticker_ids, embeds: a.embeds, allowed_mentions: a.allowed_mentions,
    flags: (a.silent ? 4096 : 0) | (a.suppress_embeds ? 4 : 0) || undefined, poll: a.poll, components: a.components,
  };
  if (a.reply_to) {
    const r = channelRef(a.reply_to);
    body.message_reference = { message_id: r.message_id ?? a.reply_to, channel_id: channelId, fail_if_not_exists: false };
    if (a.mention_reply === false) body.allowed_mentions = { ...(body.allowed_mentions || { parse: ['users', 'roles', 'everyone'] }), replied_user: false };
  }
  if (!body.content && !a.files?.length && !body.sticker_ids?.length && !body.poll && !body.embeds?.length) throw new Error('Nothing to send: give content, files, sticker_ids or a poll.');
  const m = await rest.post(`/channels/${channelId}/messages`, body, { files: a.files });
  return fmtMessage(m, { full: true });
}

const sendShape = {
  content: z.string().optional().describe('Message text (Markdown; mention users with <@id>, channels with <#id>, roles with <@&id>, custom emoji <:name:id>)'),
  reply_to: z.string().optional().describe('Message ID (or link) to reply to'),
  mention_reply: z.boolean().optional().describe('Ping the author of the replied message (default true)'),
  files: filesParam,
  sticker_ids: z.array(z.string()).optional().describe('Up to 3 sticker IDs'),
  silent: z.boolean().optional().describe('@silent: send without notifications'),
  suppress_embeds: z.boolean().optional().describe('Hide link previews'),
  tts: z.boolean().optional(),
  allowed_mentions: z.record(z.string(), z.any()).optional().describe('{parse:["users","roles","everyone"], users:[], roles:[], replied_user}'),
  poll: z.record(z.string(), z.any()).optional().describe('Raw poll object (or use create_poll)'),
  embeds: z.array(z.any()).optional().describe('Embeds (bots/webhooks only)'),
  components: z.array(z.any()).optional().describe('Components (bots only)'),
};

defineTool({
  name: 'send_message', category: 'messages',
  description: 'Send a message to a channel, thread or DM — text, replies, file/image uploads (local path or URL), stickers, silent messages. Use user_id to DM someone.',
  shape: { ...target, ...sendShape },
  handler: async (a) => send(await resolveTarget(a), a),
});

defineTool({
  name: 'send_dm', category: 'messages',
  description: 'Send a direct message to a user by user ID (opens the DM if needed).',
  shape: { user_id: z.string().describe('User ID'), ...sendShape },
  handler: async (a) => send(await dmChannel(a.user_id), a),
});

defineTool({
  name: 'reply_to_message', category: 'messages',
  description: 'Reply to a specific message (give its link, or channel_id + message_id).',
  shape: { message: z.string().describe('Message link, or message ID with channel_id'), channel_id: z.string().optional(), ...(({ reply_to, ...s }) => s)(sendShape) },
  handler: async (a) => {
    const l = channelRef(a.message);
    const channel = l.message_id ? l.channel_id : a.channel_id && channelRef(a.channel_id).channel_id;
    if (!channel) throw new Error('Need a message link or channel_id');
    return send(channel, { ...a, reply_to: l.message_id ?? a.message });
  },
});

defineTool({
  name: 'forward_message', category: 'messages',
  description: 'Forward a message to another channel or DM (Discord\'s native forward).',
  shape: {
    message: z.string().describe('Message link, or message ID with from_channel_id'), from_channel_id: z.string().optional(),
    to_channel_id: z.string().optional().describe('Destination channel ID'), to_user_id: z.string().optional().describe('Or destination user (DM)'),
    comment: z.string().optional().describe('Optional text sent with the forward'),
  },
  handler: async (a) => {
    const l = channelRef(a.message);
    const src = l.message_id ? l.channel_id : a.from_channel_id;
    const mid = l.message_id ?? a.message;
    if (!src) throw new Error('Need a message link or from_channel_id');
    const dest = await resolveTarget({ channel_id: a.to_channel_id, user_id: a.to_user_id });
    const srcCh = await getChannel(src).catch(() => ({}));
    const m = await rest.post(`/channels/${dest}/messages`, { nonce: nonce(), message_reference: { type: 1, message_id: mid, channel_id: src, guild_id: srcCh.guild_id } });
    if (a.comment) await rest.post(`/channels/${dest}/messages`, { content: a.comment, nonce: nonce() });
    return fmtMessage(m);
  },
});

defineTool({
  name: 'create_poll', category: 'messages',
  description: 'Post a poll in a channel or DM.',
  shape: {
    ...target, question: z.string(), answers: z.array(z.string()).describe('2-10 answers; prefix with an emoji + space to add one, e.g. "🍕 Pizza"'),
    duration_hours: z.number().optional().describe('1-768 hours (default 24)'), multiselect: z.boolean().optional(), content: z.string().optional(),
  },
  handler: async (a) => {
    const answers = a.answers.map((t: string) => {
      const m = t.match(/^(\p{Extended_Pictographic}️?)\s+(.*)$/u);
      return { poll_media: m ? { text: m[2], emoji: { name: m[1] } } : { text: t } };
    });
    return send(await resolveTarget(a), { content: a.content, poll: { question: { text: a.question }, answers, duration: a.duration_hours ?? 24, allow_multiselect: !!a.multiselect, layout_type: 1 } });
  },
});

defineTool({
  name: 'read_messages', category: 'messages', readOnly: true,
  description: 'Read chat history of a channel, thread or DM in readable form (oldest → newest). Paginates up to 500 messages. Use since/before/after/around to move in time.',
  shape: {
    ...target,
    limit: z.number().optional().describe('How many messages (default 50, max 500)'),
    before: z.string().optional().describe('Only messages before this message ID'),
    after: z.string().optional().describe('Only messages after this message ID'),
    around: z.string().optional().describe('Messages around this message ID'),
    since: z.string().optional().describe('Only messages after this time (ISO8601, e.g. 2026-11-20T00:00:00Z)'),
    until: z.string().optional().describe('Only messages before this time (ISO8601)'),
    full: z.boolean().optional().describe('Include full embed text, mentions and ids'),
  },
  handler: async (a) => {
    const ref = a.channel_id ? channelRef(a.channel_id) : undefined;
    const channelId = await resolveTarget(a);
    const want = Math.min(a.limit ?? 50, 500);
    let before = a.before ?? (a.until ? snowflakeAt(a.until) : undefined);
    let after = a.after ?? (a.since ? snowflakeAt(a.since) : undefined);
    const around = a.around ?? ref?.message_id;
    let msgs: any[] = [];
    if (around) {
      msgs = await rest.get(`/channels/${channelId}/messages`, { around, limit: Math.min(want, 100) });
    } else if (after && !before) {
      while (msgs.length < want) {
        const page: any[] = await rest.get(`/channels/${channelId}/messages`, { after, limit: Math.min(100, want - msgs.length) });
        if (!page.length) break;
        page.sort((x, y) => (BigInt(x.id) < BigInt(y.id) ? -1 : 1));
        msgs.push(...page); after = page[page.length - 1].id;
        if (page.length < 100) break;
      }
    } else {
      while (msgs.length < want) {
        const page: any[] = await rest.get(`/channels/${channelId}/messages`, { before, limit: Math.min(100, want - msgs.length) });
        if (!page.length) break;
        msgs.push(...page); before = page[page.length - 1].id;
        if (after) { msgs = msgs.filter((m) => BigInt(m.id) > BigInt(after!)); if (BigInt(before) <= BigInt(after)) break; }
        if (page.length < 100) break;
      }
    }
    msgs.sort((x, y) => (BigInt(x.id) < BigInt(y.id) ? -1 : 1));
    const ch = gateway.channels.get(channelId);
    return { channel: ch ? channelLabel(ch) : channelId, channel_id: channelId, count: msgs.length, messages: msgs.map((m) => fmtMessage(m, { full: a.full })), older_cursor: msgs[0]?.id, newer_cursor: msgs[msgs.length - 1]?.id };
  },
});

defineTool({
  name: 'open_message_link', category: 'messages', readOnly: true,
  description: 'Open a discord.com/channels/… message link: returns the message plus a few messages of context around it.',
  shape: { link: z.string(), context: z.number().optional().describe('Messages of context (default 5)') },
  handler: async (a) => {
    const l = parseDiscordLink(a.link);
    if (!l.channel_id) throw new Error('Not a Discord message link');
    if (!l.message_id) return { channel: await getChannel(l.channel_id) };
    const list: any[] = await rest.get(`/channels/${l.channel_id}/messages`, { around: l.message_id, limit: Math.min(1 + 2 * (a.context ?? 5), 100) });
    list.sort((x, y) => (BigInt(x.id) < BigInt(y.id) ? -1 : 1));
    return { guild_id: l.guild_id, channel_id: l.channel_id, target: l.message_id, messages: list.map((m) => ({ ...fmtMessage(m), target: m.id === l.message_id || undefined })) };
  },
});

const HAS = ['link', 'embed', 'poll', 'file', 'video', 'image', 'sound', 'sticker', 'snapshot'];

defineTool({
  name: 'search_messages', category: 'messages', readOnly: true,
  description: 'Search messages like the Discord search bar: in a server (guild_id) or a DM/channel (channel_id). Filter by text, author, mentions, attachments/links (has), channel, date range, pinned.',
  shape: {
    guild_id: z.string().optional().describe('Server to search in'),
    channel_id: z.string().optional().describe('Limit to this channel (or search a DM/group DM by its channel ID without guild_id)'),
    content: z.string().optional().describe('Text to search for'),
    author_id: z.array(z.string()).optional().describe('From these user IDs'),
    mentions: z.array(z.string()).optional().describe('Mentioning these user IDs'),
    has: z.array(z.enum(HAS as [string, ...string[]])).optional().describe('Message has: link, embed, poll, file, video, image, sound, sticker, snapshot (forward)'),
    before: z.string().optional().describe('Before this date (ISO8601)'),
    after: z.string().optional().describe('After this date (ISO8601)'),
    pinned: z.boolean().optional(),
    author_type: z.array(z.string()).optional().describe('user, bot, webhook (prefix - to exclude)'),
    sort_by: z.enum(['timestamp', 'relevance']).optional(),
    sort_order: z.enum(['desc', 'asc']).optional(),
    offset: z.number().optional().describe('Pagination offset (multiples of 25)'),
    limit: z.number().optional().describe('1-25 (default 25)'),
    include_nsfw: z.boolean().optional(),
  },
  handler: async (a) => {
    const q: any = {
      content: a.content, author_id: a.author_id, mentions: a.mentions, has: a.has, pinned: a.pinned, author_type: a.author_type,
      sort_by: a.sort_by, sort_order: a.sort_order, offset: a.offset, limit: a.limit, include_nsfw: a.include_nsfw,
      max_id: a.before ? snowflakeAt(a.before) : undefined, min_id: a.after ? snowflakeAt(a.after) : undefined,
    };
    let p: string;
    if (a.guild_id) { p = `/guilds/${a.guild_id}/messages/search`; if (a.channel_id) q.channel_id = [channelRef(a.channel_id).channel_id]; }
    else if (a.channel_id) p = `/channels/${channelRef(a.channel_id).channel_id}/messages/search`;
    else throw new Error('Give guild_id (server search) or channel_id (DM/channel search)');
    const r = await rest.get(p, q);
    const hits = (r.messages || []).map((group: any[]) => {
      const m = Array.isArray(group) ? (group.find((x) => x.hit) ?? group[0]) : group;
      const ch = gateway.channels.get(m.channel_id);
      return { ...fmtMessage(m), channel_id: m.channel_id, channel: ch ? channelLabel(ch) : undefined, link: `https://discord.com/channels/${m.guild_id ?? a.guild_id ?? '@me'}/${m.channel_id}/${m.id}` };
    });
    return { total_results: r.total_results, returned: hits.length, offset: a.offset ?? 0, messages: hits, threads: r.threads?.map((t: any) => ({ id: t.id, name: t.name })) };
  },
});

defineTool({
  name: 'download_attachments', category: 'messages',
  description: 'Download a message\'s attachments (or any CDN URL) to local files and return their paths.',
  shape: {
    message: z.string().optional().describe('Message link, or message ID with channel_id'), channel_id: z.string().optional(),
    url: z.string().optional().describe('Or a direct attachment/CDN URL'), dir: z.string().optional().describe(`Folder (default ${DOWNLOAD_DIR})`),
  },
  handler: async (a) => {
    const dir = a.dir || DOWNLOAD_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const items: { url: string; filename: string }[] = [];
    if (a.url) items.push({ url: a.url, filename: decodeURIComponent(new URL(a.url).pathname.split('/').pop() || 'file') });
    if (a.message) {
      const l = channelRef(a.message);
      const ch = l.message_id ? l.channel_id : a.channel_id;
      if (!ch) throw new Error('Need a message link or channel_id');
      const m = await fetchMessage(ch, l.message_id ?? a.message);
      for (const at of m.attachments || []) items.push({ url: at.url, filename: `${at.id}_${at.filename}` });
      for (const s of m.message_snapshots || []) for (const at of s.message?.attachments || []) items.push({ url: at.url, filename: `${at.id}_${at.filename}` });
    }
    if (!items.length) return { files: [], note: 'No attachments found.' };
    const out = [];
    for (const it of items) {
      const f = await loadFile({ url: it.url });
      const dest = path.join(dir, it.filename.replace(/[/\\]/g, '_'));
      fs.writeFileSync(dest, f.data);
      out.push({ path: dest, bytes: f.data.length, type: f.type });
    }
    return { files: out };
  },
});

defineTool({
  name: 'view_image', category: 'messages', readOnly: true,
  description: 'Look at an image: a message attachment (message link/ID + optional index) or any image URL. Returns the image itself.',
  shape: { url: z.string().optional(), message: z.string().optional(), channel_id: z.string().optional(), index: z.number().optional().describe('Attachment index (default 0)') },
  handler: async (a) => {
    let url = a.url;
    if (!url && a.message) {
      const l = channelRef(a.message);
      const m = await fetchMessage(l.message_id ? l.channel_id : a.channel_id, l.message_id ?? a.message);
      const imgs = [...(m.attachments || []).filter((x: any) => x.content_type?.startsWith('image/')).map((x: any) => x.url),
        ...(m.embeds || []).map((e: any) => e.image?.url || e.thumbnail?.url).filter(Boolean)];
      url = imgs[a.index ?? 0];
      if (!url) throw new Error('That message has no image');
    }
    if (!url) throw new Error('Give url or message');
    const f = await loadFile({ url });
    if (f.data.length > 8_000_000) throw new Error('Image too large to view (>8MB); use download_attachments.');
    const type = f.type.startsWith('image/') ? f.type : 'image/png';
    return { __image: { data: f.data.toString('base64'), mimeType: type }, text: url };
  },
});

defineTool({
  name: 'purge_my_messages', category: 'messages', destructive: true,
  description: 'Delete your own recent messages in a channel/DM (optionally only those containing some text). Goes slowly to respect rate limits.',
  shape: {
    ...target, limit: z.number().optional().describe('Max messages of yours to delete (default 20, max 500)'),
    contains: z.string().optional().describe('Only delete messages containing this text'),
    after: z.string().optional().describe('Only messages after this time (ISO8601)'),
    dry_run: z.boolean().optional().describe('Only list what would be deleted'),
  },
  handler: async (a) => {
    const channelId = await resolveTarget(a);
    const myId = (await me()).id;
    const want = Math.min(a.limit ?? 20, 500);
    const stopAt = a.after ? BigInt(snowflakeAt(a.after)) : 0n;
    const found: any[] = [];
    let before: string | undefined;
    for (let pages = 0; found.length < want && pages < 50; pages++) {
      const page: any[] = await rest.get(`/channels/${channelId}/messages`, { before, limit: 100 });
      if (!page.length) break;
      for (const m of page) {
        if (BigInt(m.id) <= stopAt) { pages = 99; break; }
        if (m.author?.id === myId && [0, 19, 20, 23].includes(m.type) && (!a.contains || m.content?.includes(a.contains))) found.push(m);
        if (found.length >= want) break;
      }
      before = page[page.length - 1].id;
    }
    if (a.dry_run) return { would_delete: found.map((m) => fmtMessage(m)) };
    let deleted = 0;
    for (const m of found) { await rest.delete(`/channels/${channelId}/messages/${m.id}`); deleted++; await sleep(700); }
    return { deleted };
  },
});

defineTool({
  name: 'edit_my_message', category: 'messages',
  description: 'Change the text of one of your messages (message link, or ID + channel_id).',
  shape: { message: z.string(), channel_id: z.string().optional(), content: z.string() },
  handler: async (a) => {
    const l = channelRef(a.message);
    const ch = l.message_id ? l.channel_id : a.channel_id;
    return fmtMessage(await rest.patch(`/channels/${ch}/messages/${l.message_id ?? a.message}`, { content: a.content }));
  },
});

defineTool({
  name: 'react', category: 'reactions',
  description: 'React to a message by link (or channel_id + message_id) with one or more emojis.',
  shape: { message: z.string(), channel_id: z.string().optional(), emojis: z.array(z.string()).describe('Unicode emojis or custom name:id'), super: z.boolean().optional().describe('Super (burst) reaction') },
  handler: async (a) => {
    const l = channelRef(a.message);
    const ch = l.message_id ? l.channel_id : a.channel_id;
    const mid = l.message_id ?? a.message;
    for (const e of a.emojis) {
      const em = e.trim().replace(/^<a?:(\w+):(\d+)>$/, '$1:$2');
      await rest.put(`/channels/${ch}/messages/${mid}/reactions/${encodeURIComponent(em)}/@me`, undefined, { query: { location: 'Message', type: a.super ? 1 : 0 } });
    }
    return { ok: true, reacted: a.emojis };
  },
});
