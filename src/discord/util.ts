/* Small helpers: snowflakes, permissions, pruning output. */

export const DISCORD_EPOCH = 1420070400000n;

export function snowflakeTime(id: string | undefined | null): Date | undefined {
  if (!id || !/^\d+$/.test(id)) return undefined;
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

/** A snowflake for a point in time (useful as before/after cursors). */
export function snowflakeAt(date: Date | number | string): string {
  const ms = BigInt(new Date(date).getTime());
  return (((ms - DISCORD_EPOCH) << 22n)).toString();
}

export function cmpId(a?: string | null, b?: string | null): number {
  const x = BigInt(a || 0), y = BigInt(b || 0);
  return x < y ? -1 : x > y ? 1 : 0;
}

export const PERMISSIONS: Record<string, bigint> = {
  CREATE_INSTANT_INVITE: 1n << 0n, KICK_MEMBERS: 1n << 1n, BAN_MEMBERS: 1n << 2n, ADMINISTRATOR: 1n << 3n, MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n, ADD_REACTIONS: 1n << 6n, VIEW_AUDIT_LOG: 1n << 7n, PRIORITY_SPEAKER: 1n << 8n, STREAM: 1n << 9n, VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n, SEND_TTS_MESSAGES: 1n << 12n, MANAGE_MESSAGES: 1n << 13n, EMBED_LINKS: 1n << 14n, ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n, MENTION_EVERYONE: 1n << 17n, USE_EXTERNAL_EMOJIS: 1n << 18n, VIEW_GUILD_INSIGHTS: 1n << 19n, CONNECT: 1n << 20n,
  SPEAK: 1n << 21n, MUTE_MEMBERS: 1n << 22n, DEAFEN_MEMBERS: 1n << 23n, MOVE_MEMBERS: 1n << 24n, USE_VAD: 1n << 25n, CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n, MANAGE_ROLES: 1n << 28n, MANAGE_WEBHOOKS: 1n << 29n, MANAGE_GUILD_EXPRESSIONS: 1n << 30n, USE_APPLICATION_COMMANDS: 1n << 31n,
  REQUEST_TO_SPEAK: 1n << 32n, MANAGE_EVENTS: 1n << 33n, MANAGE_THREADS: 1n << 34n, CREATE_PUBLIC_THREADS: 1n << 35n, CREATE_PRIVATE_THREADS: 1n << 36n,
  USE_EXTERNAL_STICKERS: 1n << 37n, SEND_MESSAGES_IN_THREADS: 1n << 38n, USE_EMBEDDED_ACTIVITIES: 1n << 39n, MODERATE_MEMBERS: 1n << 40n,
  VIEW_CREATOR_MONETIZATION_ANALYTICS: 1n << 41n, USE_SOUNDBOARD: 1n << 42n, CREATE_GUILD_EXPRESSIONS: 1n << 43n, CREATE_EVENTS: 1n << 44n,
  USE_EXTERNAL_SOUNDS: 1n << 45n, SEND_VOICE_MESSAGES: 1n << 46n, SEND_POLLS: 1n << 49n, USE_EXTERNAL_APPS: 1n << 50n, PIN_MESSAGES: 1n << 51n,
  BYPASS_SLOWMODE: 1n << 52n,
};
export const ALL_PERMISSIONS = Object.values(PERMISSIONS).reduce((a, b) => a | b, 0n);

export function permissionNames(bits: bigint | string | number): string[] {
  const b = BigInt(bits);
  if (b & PERMISSIONS.ADMINISTRATOR) return ['ADMINISTRATOR (all permissions)'];
  return Object.entries(PERMISSIONS).filter(([, v]) => (b & v) === v).map(([k]) => k);
}

/** Accept a number/string bitfield or a list of permission names. */
export function permissionBits(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) {
    let b = 0n;
    for (const n of v) {
      const k = String(n).toUpperCase().replace(/[\s-]+/g, '_');
      if (!(k in PERMISSIONS)) throw new Error(`Unknown permission "${n}". Known: ${Object.keys(PERMISSIONS).join(', ')}`);
      b |= PERMISSIONS[k];
    }
    return b.toString();
  }
  if (typeof v === 'string' && /[A-Za-z]/.test(v)) return permissionBits(v.split(/[,|\s]+/).filter(Boolean));
  return String(v);
}

/** Remove null/undefined, empty arrays and empty objects, to keep tool output small. */
export function prune(v: any, depth = 0): any {
  if (Array.isArray(v)) return v.map((x) => prune(x, depth + 1)).filter((x) => x !== undefined);
  if (v && typeof v === 'object') {
    const out: any = {};
    for (const [k, x] of Object.entries(v)) {
      const p = prune(x, depth + 1);
      if (p === undefined || p === null) continue;
      if (Array.isArray(p) && p.length === 0) continue;
      if (p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 0) continue;
      out[k] = p;
    }
    return out;
  }
  return v;
}

export function parseDiscordLink(url: string): { guild_id?: string; channel_id?: string; message_id?: string } {
  const m = url.match(/discord(?:app)?\.com\/channels\/(@me|\d+)\/(\d+)(?:\/(\d+))?/);
  if (!m) return {};
  return { guild_id: m[1] === '@me' ? undefined : m[1], channel_id: m[2], message_id: m[3] };
}

export function inviteCode(v: string): string {
  const m = v.match(/(?:discord(?:app)?\.(?:gg|com\/invite)|discord\.com\/invite)\/([\w-]+)/i);
  return m ? m[1] : v.trim().replace(/^.*\//, '');
}

/** Emoji for URLs: unicode as-is, custom as name:id (accepts <:name:id>, <a:name:id>, name:id). */
export function emojiParam(e: string): string {
  const t = e.trim();
  const m = t.match(/^<a?:(\w+):(\d+)>$/);
  if (m) return `${m[1]}:${m[2]}`;
  return t.replace(/^:|:$/g, '') === t ? t : t;
}

export function nonce(): string { return snowflakeAt(Date.now()); }
