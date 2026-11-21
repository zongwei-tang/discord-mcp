/* Declarative endpoint tools: a compact spec per Discord route becomes a typed MCP tool. */
import { z } from 'zod';
import { rest, toDataUri, type FileInput } from '../discord/rest.js';
import { emojiParam, inviteCode, permissionBits } from '../discord/util.js';
import { defineTool } from './registry.js';

/**
 * Parameter spec: "<type>[~][!][|description]"
 *   s string · i integer · n number · b boolean · id snowflake · ids snowflake[] · ss string[] · is int[]
 *   a any[] · o object · any · data (local path / URL / data: URI, sent as a data URI) · ts ISO8601 timestamp
 *   ~ nullable (send null to clear) · ! required
 */
export interface Ep {
  c: string;                 // category
  n: string;                 // tool name
  r: string;                 // "METHOD /path/{param}"
  d: string;                 // description
  q?: Record<string, string>;
  b?: Record<string, string>;
  p?: Record<string, string>; // path param docs/overrides ("s|desc"; add "?=default" via pathDefaults)
  reason?: boolean;
  files?: boolean;
  fileField?: string;
  formFields?: boolean;
  arrayBody?: string;
  fixed?: Record<string, unknown>;
  fixedQuery?: Record<string, unknown>;
  pathDefaults?: Record<string, string>;
  ro?: boolean;
  destructive?: boolean;
  strict?: boolean;          // don't pass unknown args through
}

export const PATH_DOCS: Record<string, string> = {
  guild_id: 'Server (guild) ID',
  channel_id: 'Channel ID (text, voice, thread, forum or DM channel)',
  message_id: 'Message ID',
  user_id: 'User ID',
  role_id: 'Role ID',
  emoji: 'Emoji: unicode (e.g. 👍) or custom as name:id (e.g. blobwave:123456789)',
  emoji_id: 'Custom emoji ID',
  reaction_type: 'Reaction type: 0 = normal, 1 = super reaction',
  webhook_id: 'Webhook ID',
  webhook_token: 'Webhook token',
  invite_code: 'Invite code or full invite link (discord.gg/xyz)',
  application_id: 'Application (app/bot) ID',
  command_id: 'Application command ID',
  event_id: 'Scheduled event ID',
  exception_id: 'Recurring event exception ID',
  tag_id: 'Forum tag ID',
  overwrite_id: 'Role ID or user ID that the permission overwrite targets',
  template_code: 'Server template code (discord.new/xyz)',
  sticker_id: 'Sticker ID',
  pack_id: 'Sticker pack ID',
  sound_id: 'Soundboard sound ID',
  rule_id: 'AutoMod rule ID',
  integration_id: 'Integration ID',
  connection_type: 'Connection platform, e.g. github, spotify, steam, twitch, xbox, reddit, youtube',
  connection_id: 'Connection account ID',
  item_id: 'Notification item ID',
  token_id: 'Authorization (OAuth2 token) ID',
  category_id: 'Discovery category ID',
  snapshot_id: 'Snapshot ID',
  avatar_id: 'Recent avatar ID',
  read_state_type: 'Read state type: 1 guild events, 2 notification center, 3 guild home, 4 guild onboarding question, 5 message requests',
  entity_id: 'Entity ID',
  answer_id: 'Poll answer ID (1-based)',
  request_id: 'Join request ID',
  audio_context_type: '"user" or "stream"',
};

export const PARAM_DOCS: Record<string, string> = {
  content: 'Message text (up to 2000 characters; Markdown supported)',
  name: 'Name',
  topic: 'Channel topic',
  nsfw: 'Age-restricted',
  position: 'Sort position',
  parent_id: 'Category ID (for channels) or parent channel ID',
  rate_limit_per_user: 'Slowmode in seconds (0-21600)',
  bitrate: 'Voice bitrate in bits/s (8000-384000)',
  user_limit: 'Voice user limit (0 = unlimited)',
  permission_overwrites: 'Permission overwrites: [{id, type: 0=role|1=member, allow, deny}] (allow/deny are bitfield strings)',
  color: 'Colour as an RGB integer (e.g. 16711680 = #FF0000)',
  colors: 'Role colours {primary_color, secondary_color, tertiary_color} (gradient roles)',
  hoist: 'Show members with this role separately',
  mentionable: 'Anyone can @mention this role',
  permissions: 'Permissions: bitfield string, or names like ["VIEW_CHANNEL","SEND_MESSAGES"]',
  allow: 'Allowed permissions: bitfield string or names',
  deny: 'Denied permissions: bitfield string or names',
  icon: 'Icon image: local file path, http(s) URL or data: URI',
  image: 'Image: local file path, http(s) URL or data: URI',
  avatar: 'Avatar image: local file path, http(s) URL or data: URI (null removes it)',
  banner: 'Banner image: local file path, http(s) URL or data: URI',
  splash: 'Invite splash image: local file path, URL or data: URI',
  discovery_splash: 'Discovery splash image: local file path, URL or data: URI',
  sound: 'Sound file (mp3/ogg, ≤512KB, ≤5.2s): local file path, URL or data: URI',
  unicode_emoji: 'Unicode emoji used as the role icon',
  nick: 'Nickname (null or "" resets it)',
  roles: 'Role IDs (replaces the full list)',
  mute: 'Server-mute in voice',
  deaf: 'Server-deafen in voice',
  communication_disabled_until: 'Timeout until this ISO8601 time (max 28 days ahead); null removes the timeout',
  delete_message_seconds: 'Also delete their messages from the last N seconds (0-604800)',
  max_age: 'Seconds until the invite expires (0 = never, default 86400)',
  max_uses: 'Max uses (0 = unlimited)',
  temporary: 'Members joined through this invite are kicked when they disconnect unless given a role',
  unique: 'Always create a new invite instead of reusing a similar one',
  limit: 'Max results',
  before: 'Return items before this ID (pagination)',
  after: 'Return items after this ID (pagination)',
  around: 'Return items around this ID',
  with_counts: 'Include approximate member/presence counts',
  with_expiration: 'Include expiration date',
  auto_archive_duration: 'Auto-archive after inactivity, in minutes: 60, 1440, 4320 or 10080',
  archived: 'Archived',
  locked: 'Locked (only moderators can unarchive)',
  invitable: 'Non-moderators can add others (private threads)',
  applied_tags: 'Forum tag IDs to apply',
  description: 'Description',
  username: 'Username',
  global_name: 'Display name',
  bio: 'About me text',
  pronouns: 'Pronouns',
  accent_color: 'Profile accent colour (RGB integer)',
  scheduled_start_time: 'Start time (ISO8601)',
  scheduled_end_time: 'End time (ISO8601, required for external events)',
  privacy_level: 'Privacy level: 2 = guild only',
  entity_type: 'Event type: 1 = stage, 2 = voice, 3 = external (somewhere else)',
  entity_metadata: 'For external events: {"location": "..."}',
  channel_id: 'Channel ID',
  user_id: 'User ID',
  query: 'Search text',
  tags: 'Tags / related emoji name',
  emoji_name: 'Unicode emoji or custom emoji name',
  emoji_id: 'Custom emoji ID',
  flags: 'Flags bitfield',
  embeds: 'Embeds: [{title, description, url, color, fields:[{name,value,inline}], image:{url}, thumbnail:{url}, footer:{text}, author:{name}}] (bots/webhooks only)',
  components: 'Message components (bots/webhooks only)',
  allowed_mentions: 'Control pings: {parse: ["users","roles","everyone"], users: [...], roles: [...], replied_user: bool}',
  sticker_ids: 'Up to 3 sticker IDs',
  message_reference: 'Reply/forward target: {message_id, channel_id?, guild_id?, type?: 0 reply | 1 forward}',
  poll: 'Poll: {question:{text}, answers:[{poll_media:{text, emoji?}}], duration: hours, allow_multiselect}',
  tts: 'Text-to-speech message',
  video_quality_mode: 'Video quality: 1 auto, 2 720p',
  rtc_region: 'Voice region id (null = automatic)',
  default_auto_archive_duration: 'Default thread auto-archive (minutes)',
  available_tags: 'Forum tags: [{name, moderated?, emoji_id?, emoji_name?}]',
  default_reaction_emoji: 'Default forum reaction {emoji_id?, emoji_name?}',
  default_sort_order: 'Forum sort: 0 latest activity, 1 creation date',
  default_forum_layout: 'Forum layout: 0 not set, 1 list, 2 gallery',
  verification_level: 'Verification level 0-4 (none, low, medium, high, very high)',
  explicit_content_filter: 'Media filter: 0 off, 1 members without roles, 2 everyone',
  default_message_notifications: '0 all messages, 1 only @mentions',
  afk_channel_id: 'AFK voice channel ID',
  afk_timeout: 'AFK timeout in seconds (60, 300, 900, 1800, 3600)',
  system_channel_id: 'Channel for system messages (joins, boosts)',
  rules_channel_id: 'Rules channel ID',
  public_updates_channel_id: 'Community updates channel ID',
  preferred_locale: 'Preferred locale, e.g. en-US',
  features: 'Guild feature flags (e.g. ["COMMUNITY"])',
  owner_id: 'Transfer ownership to this user ID',
  enabled: 'Enabled',
  volume: 'Volume 0-1',
  sound_id: 'Soundboard sound ID',
  source_guild_id: 'Guild the sound comes from (for sounds from another server)',
  target_type: 'Invite target: 1 stream, 2 embedded application',
  target_user_id: 'User whose stream to show (target_type 1)',
  target_application_id: 'Embedded application ID (target_type 2)',
  request_to_speak_timestamp: 'Raise hand: ISO8601 time, null lowers it',
  suppress: 'Suppressed (audience) in a stage',
  action_type: 'Audit log action type number',
  target_id: 'Target ID',
  reason: 'Reason (shown in the audit log)',
  note: 'Note text',
  type: 'Type',
  status: 'Status',
  code: 'Code',
  guild_id: 'Server (guild) ID',
  message_id: 'Message ID',
  role_ids: 'Role IDs',
  user_ids: 'User IDs',
  channel_ids: 'Channel IDs',
  offset: 'Skip this many results',
  sort_by: 'Sort by',
  sort_order: 'asc or desc',
};

function zFor(spec: string, key: string, fallbackDoc?: string): z.ZodType {
  const [t, doc] = spec.split('|');
  const required = t.includes('!');
  const nullable = t.includes('~');
  const base = t.replace(/[!~]/g, '');
  let s: z.ZodType;
  switch (base) {
    case 's': case 'ts': case 'data': case 'id': s = z.string(); break;
    case 'i': s = z.number(); break;
    case 'n': s = z.number(); break;
    case 'b': s = z.boolean(); break;
    case 'ids': case 'ss': s = z.array(z.string()); break;
    case 'is': s = z.array(z.number()); break;
    case 'a': s = z.array(z.any()); break;
    case 'o': s = z.record(z.string(), z.any()); break;
    case 'perm': s = z.union([z.string(), z.array(z.string())]); break;
    default: s = z.any();
  }
  if (['permissions', 'allow', 'deny'].includes(key) && base === 's') s = z.union([z.string(), z.array(z.string())]);
  let d = doc || PARAM_DOCS[key] || fallbackDoc || key.replace(/_/g, ' ');
  if (base === 'id' && !doc && !PARAM_DOCS[key]) d = `${d} (ID)`;
  if (base === 'ts' && !doc) d = `${d} (ISO8601 time)`;
  if (base === 'data' && !doc && !PARAM_DOCS[key]) d = `${d}: local file path, http(s) URL or data: URI`;
  s = s.describe(d);
  if (nullable) s = s.nullable();
  if (!required) s = s.optional();
  return s;
}

const fileSchema = z.object({
  path: z.string().optional().describe('Local file path'),
  url: z.string().optional().describe('http(s) URL to download and attach'),
  data_base64: z.string().optional().describe('Base64 data (or data: URI)'),
  filename: z.string().optional(),
  description: z.string().optional().describe('Alt text'),
  spoiler: z.boolean().optional(),
});
export const filesParam = z.array(fileSchema).optional().describe('Files to attach (each: path, url or data_base64)');

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

export function buildEndpoint(ep: Ep) {
  const [method, rawPath] = ep.r.split(' ');
  const pathParams = [...rawPath.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const shape: Record<string, z.ZodType> = {};
  for (const p of pathParams) {
    let s: z.ZodType = z.string().describe(ep.p?.[p] || PATH_DOCS[p] || p.replace(/_/g, ' '));
    if (ep.pathDefaults?.[p] !== undefined) s = (s as z.ZodString).optional().describe(`${ep.p?.[p] || PATH_DOCS[p] || p} (default ${ep.pathDefaults[p]})`);
    shape[p] = s;
  }
  const q = ep.q || {};
  const b = ep.b || {};
  const bodyTypes: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) if (!(k in shape)) shape[k] = zFor(v, k);
  for (const [k, v] of Object.entries(b)) {
    if (k in shape) continue;
    shape[k] = zFor(v, k);
    bodyTypes[k] = v.split('|')[0].replace(/[!~]/g, '');
  }
  if (ep.arrayBody && !(ep.arrayBody in shape)) shape[ep.arrayBody] = z.array(z.any()).describe('Array body');
  if (ep.reason && !('reason' in shape)) shape.reason = z.string().optional().describe('Reason (shown in the audit log)');
  if (ep.files) shape.files = filesParam;

  const hasBody = BODY_METHODS.has(method);
  defineTool({
    name: ep.n,
    category: ep.c,
    description: ep.d,
    shape,
    loose: !ep.strict,
    readOnly: ep.ro ?? method === 'GET',
    destructive: ep.destructive ?? (method === 'DELETE' || /(^|_)(delete|ban|kick|prune|remove|purge|revoke)(_|$)/.test(ep.n)),
    handler: async (args: Record<string, any>) => {
      const a = { ...args };
      let path = rawPath;
      for (const p of pathParams) {
        let v = a[p] ?? ep.pathDefaults?.[p];
        if (v === undefined || v === '') throw new Error(`Missing ${p}`);
        v = String(v);
        if (p === 'emoji') v = emojiParam(v);
        if (p === 'invite_code') v = inviteCode(v);
        path = path.replace(`{${p}}`, encodeURIComponent(v).replace(/%40me$/, '@me'));
        delete a[p];
      }
      const query: Record<string, unknown> = { ...(ep.fixedQuery || {}) };
      let body: any = hasBody ? { ...(ep.fixed || {}) } : undefined;
      const reason = ep.reason && !(ep.b && 'reason' in ep.b) ? a.reason : undefined;
      if (reason !== undefined) delete a.reason;
      const files: FileInput[] | undefined = a.files;
      delete a.files;
      for (const [k, v] of Object.entries(a)) {
        if (v === undefined) continue;
        if (k in q) { query[k] = v; continue; }
        if (hasBody && (k in b || !(k in q))) {
          let val = v;
          if (bodyTypes[k] === 'data') val = await toDataUri(v);
          if (['permissions', 'allow', 'deny'].includes(k)) val = permissionBits(v) ?? v;
          if (k === ep.arrayBody) { body = val; continue; }
          if (!Array.isArray(body)) body[k] = val;
        } else {
          query[k] = v;
        }
      }
      if (body && !Array.isArray(body) && Object.keys(body).length === 0 && method !== 'PATCH') body = method === 'PUT' || method === 'POST' ? {} : undefined;
      return rest.request(method, path, { query, body, files, reason, fileField: ep.fileField, formFields: ep.formFields });
    },
  });
}

export function buildAll(eps: Ep[]) { for (const ep of eps) buildEndpoint(ep); }
