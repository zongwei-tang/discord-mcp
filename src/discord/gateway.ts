/* Live gateway connection: session id, READY cache (guilds, channels, DMs, read states), event buffer, presence/voice ops. */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { GATEWAY_URL, currentAccount, settings, type SavedAccount } from '../config.js';
import { properties, userAgent } from './client-props.js';
import { ALL_PERMISSIONS, PERMISSIONS, cmpId, nonce } from './util.js';
import { NotLoggedIn } from './rest.js';

export interface GwEvent { seq: number; t: string; at: number; d: any }

// LAZY_USER_NOTES | NO_AFFINE_USER_IDS | VERSIONED_READ_STATES | VERSIONED_USER_GUILD_SETTINGS | DEDUPE_USER_OBJECTS
const USER_CAPABILITIES = 1 | 2 | 4 | 8 | 16;
// all non-privileged intents + MESSAGE_CONTENT, GUILD_MEMBERS, GUILD_PRESENCES (dropped automatically if not enabled)
const BOT_INTENTS_ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 21, 24, 25].reduce((a, b) => a | (1 << b), 0);
const PRIVILEGED = (1 << 1) | (1 << 8) | (1 << 15);
const NOISY = new Set(['PRESENCE_UPDATE', 'TYPING_START', 'GUILD_MEMBER_LIST_UPDATE', 'SESSIONS_REPLACE', 'PASSIVE_UPDATE_V1', 'PASSIVE_UPDATE_V2',
  'CHANNEL_UNREAD_UPDATE', 'READY_SUPPLEMENTAL', 'GUILD_MEMBERS_CHUNK', 'CONVERSATION_SUMMARY_UPDATE', 'CONTENT_INVENTORY_INBOX_STALE', 'BURST_CREDIT_BALANCE_UPDATE']);
const MAX_EVENTS = 2000;
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Gateway extends EventEmitter {
  ws?: WebSocket;
  status: 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'failed' | 'closed' = 'idle';
  error?: string;
  seq: number | null = null;
  sessionId?: string;
  resumeUrl?: string;
  user: any;
  account?: SavedAccount;
  intents = BOT_INTENTS_ALL;
  connectedAt?: number;

  guilds = new Map<string, any>();       // id -> normalised guild {id,name,owner_id,roles,channels,member(me)...}
  channels = new Map<string, any>();     // id -> channel (guild channels, threads, DMs)
  readStates = new Map<string, any>();   // channel id -> {last_message_id, mention_count}
  relationships = new Map<string, any>();
  guildSettings = new Map<string, any>();
  users = new Map<string, any>();
  voice = new Map<string, any>();        // guild id ('@me' for calls) -> my voice state
  sessions: any[] = [];
  modals: any[] = [];
  events: GwEvent[] = [];
  private evSeq = 0;
  private hb?: NodeJS.Timeout;
  private acked = true;
  private readyWaiters: { res: () => void; rej: (e: Error) => void }[] = [];
  private backoff = 1000;
  private stopping = false;
  presence: { status: string; activities: any[]; afk: boolean; since: number } = { status: 'online', activities: [], afk: false, since: 0 };

  get isBot() { return this.account?.type === 'bot'; }

  /** Connect if needed and wait for READY. */
  ensure(timeoutMs = 30_000): Promise<void> {
    if (!settings.gateway) return Promise.reject(new Error('The live gateway is turned off (DISCORD_GATEWAY=off); this tool needs it.'));
    if (this.status === 'ready') return Promise.resolve();
    if (this.status === 'failed') { this.status = 'idle'; }
    const p = new Promise<void>((res, rej) => {
      this.readyWaiters.push({ res, rej });
      setTimeout(() => rej(new Error(`Gateway not ready after ${timeoutMs / 1000}s (${this.error || this.status}).`)), timeoutMs).unref();
    });
    if (this.status === 'idle' || this.status === 'closed') this.connect();
    return p;
  }

  connect() {
    const acc = currentAccount();
    if (!acc?.token) { this.fail(new NotLoggedIn().message); return; }
    this.account = acc;
    this.stopping = false;
    this.status = this.sessionId ? 'reconnecting' : 'connecting';
    const base = this.sessionId && this.resumeUrl ? this.resumeUrl : GATEWAY_URL;
    const ws = new WebSocket(`${base}/?encoding=json&v=9`, {
      headers: this.isBot ? {} : { 'User-Agent': userAgent, Origin: 'https://discord.com' },
      perMessageDeflate: false,
    });
    this.ws = ws;
    ws.on('message', (raw) => { try { this.onPacket(JSON.parse(raw.toString())); } catch (e) { this.error = `bad packet: ${(e as Error).message}`; } });
    ws.on('close', (code, reason) => this.onClose(ws, code, reason.toString()));
    ws.on('error', (e) => { this.error = e.message; });
  }

  close() {
    this.stopping = true;
    clearInterval(this.hb);
    try { this.ws?.close(1000); } catch { /* ignore */ }
    this.status = 'closed';
    this.sessionId = undefined;
  }

  send(op: number, d: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Gateway is not connected.');
    this.ws.send(JSON.stringify({ op, d }));
  }

  private fail(msg: string) {
    this.status = 'failed';
    this.error = msg;
    for (const w of this.readyWaiters.splice(0)) w.rej(new Error(msg));
  }

  private onClose(ws: WebSocket, code: number, reason: string) {
    if (ws !== this.ws) return;
    clearInterval(this.hb);
    if (this.stopping) return;
    if (code === 4014 && this.isBot && this.intents & PRIVILEGED) {
      this.intents &= ~PRIVILEGED; this.sessionId = undefined;
      setTimeout(() => this.connect(), 500);
      return;
    }
    if (FATAL.has(code)) {
      this.sessionId = undefined;
      this.fail(code === 4004 ? 'Discord rejected the token (logged out or invalid). Log in again.' : `Gateway closed: ${code} ${reason}`);
      return;
    }
    if (code === 4007 || code === 4009) this.sessionId = undefined;
    this.status = 'reconnecting';
    this.error = `closed ${code} ${reason}`.trim();
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    setTimeout(() => { if (!this.stopping) this.connect(); }, wait).unref();
  }

  private onPacket(p: { op: number; d: any; s?: number; t?: string }) {
    if (p.s) this.seq = p.s;
    switch (p.op) {
      case 10: { // hello
        const iv = p.d.heartbeat_interval;
        clearInterval(this.hb);
        this.acked = true;
        setTimeout(() => this.beat(), Math.floor(iv * Math.random())).unref();
        this.hb = setInterval(() => this.beat(), iv);
        this.hb.unref();
        if (this.sessionId) this.send(6, { token: this.account!.token, session_id: this.sessionId, seq: this.seq });
        else this.identify();
        break;
      }
      case 11: this.acked = true; break;
      case 1: this.beat(true); break;
      case 7: try { this.ws?.close(4900); } catch { /* ignore */ } break;
      case 9: // invalid session
        if (!p.d) { this.sessionId = undefined; this.seq = null; }
        setTimeout(() => { if (this.sessionId) this.send(6, { token: this.account!.token, session_id: this.sessionId, seq: this.seq }); else this.identify(); }, 1000 + Math.random() * 3000).unref();
        break;
      case 0: this.dispatch(p.t!, p.d); break;
    }
  }

  private beat(force = false) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.acked && !force) { try { this.ws.terminate(); } catch { /* ignore */ } return; }
    this.acked = false;
    this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
  }

  private identify() {
    const a = this.account!;
    if (a.type === 'bot') {
      this.send(2, { token: a.token, intents: this.intents, properties: { os: process.platform, browser: 'discord-mcp', device: 'discord-mcp' } });
    } else {
      this.send(2, {
        token: a.token, capabilities: USER_CAPABILITIES, properties: properties(),
        presence: { status: 'unknown', since: 0, activities: [], afk: false }, compress: false, client_state: { guild_versions: {} },
      });
    }
  }

  // ---------------------------------------------------------------- state
  private normGuild(g: any, memberMe?: any) {
    const props = g.properties ?? g;
    const guild: any = {
      id: g.id, name: props.name, icon: props.icon, owner_id: props.owner_id, description: props.description,
      features: props.features, member_count: g.member_count ?? props.member_count, premium_tier: props.premium_tier,
      vanity_url_code: props.vanity_url_code, joined_at: g.joined_at, large: g.large,
      roles: new Map<string, any>((g.roles || []).map((r: any) => [r.id, r])),
      emojis: g.emojis || [], stickers: g.stickers || [],
      member: memberMe ?? (g.members || []).find((m: any) => (m.user_id ?? m.user?.id) === this.user?.id),
      voice_states: g.voice_states || [],
      unavailable: g.unavailable,
    };
    this.guilds.set(g.id, guild);
    for (const c of g.channels || []) this.channels.set(c.id, { ...c, guild_id: g.id });
    for (const t of g.threads || []) this.channels.set(t.id, { ...t, guild_id: g.id });
    const mine = guild.voice_states.find((v: any) => v.user_id === this.user?.id);
    if (mine) this.voice.set(g.id, { ...mine, guild_id: g.id });
    return guild;
  }

  private hydrateUser(id?: string) { return id ? this.users.get(id) ?? { id } : undefined; }

  private onReady(d: any) {
    this.user = d.user;
    this.sessionId = d.session_id;
    this.resumeUrl = d.resume_gateway_url;
    this.sessions = d.sessions || [];
    this.users.clear();
    for (const u of d.users || []) this.users.set(u.id, u);
    this.users.set(d.user.id, d.user);
    this.guilds.clear(); this.channels.clear(); this.readStates.clear(); this.relationships.clear(); this.guildSettings.clear();
    (d.guilds || []).forEach((g: any, i: number) => {
      const members = d.merged_members?.[i] || [];
      const me = members.find((m: any) => (m.user_id ?? m.user?.id) === d.user.id);
      this.normGuild(g, me);
    });
    for (const c of d.private_channels || []) {
      const recipients = c.recipients ?? (c.recipient_ids || []).map((id: string) => this.hydrateUser(id));
      this.channels.set(c.id, { ...c, recipients });
    }
    const rs = Array.isArray(d.read_state) ? d.read_state : d.read_state?.entries || [];
    for (const r of rs) if (!r.read_state_type) this.readStates.set(r.id, r);
    for (const r of d.relationships || []) this.relationships.set(r.id ?? r.user_id, { ...r, user: r.user ?? this.hydrateUser(r.user_id ?? r.id) });
    const ugs = Array.isArray(d.user_guild_settings) ? d.user_guild_settings : d.user_guild_settings?.entries || [];
    for (const s of ugs) this.guildSettings.set(s.guild_id ?? '@me', s);
    const st = d.user_settings?.status;
    if (st) this.presence.status = st;
    const cs = d.user_settings?.custom_status;
    if (cs?.text || cs?.emoji_name) this.presence.activities = [{ type: 4, name: 'Custom Status', state: cs.text, emoji: cs.emoji_name ? { name: cs.emoji_name, id: cs.emoji_id } : undefined }];
    this.status = 'ready';
    this.error = undefined;
    this.backoff = 1000;
    this.connectedAt = Date.now();
    for (const w of this.readyWaiters.splice(0)) w.res();
  }

  private dispatch(t: string, d: any) {
    switch (t) {
      case 'READY': this.onReady(d); break;
      case 'RESUMED': this.status = 'ready'; this.backoff = 1000; for (const w of this.readyWaiters.splice(0)) w.res(); break;
      case 'GUILD_CREATE': this.normGuild(d); break;
      case 'GUILD_UPDATE': { const g = this.guilds.get(d.id); if (g) Object.assign(g, { name: d.name, icon: d.icon, owner_id: d.owner_id, description: d.description, features: d.features }); break; }
      case 'GUILD_DELETE': if (!d.unavailable) { this.guilds.delete(d.id); for (const [id, c] of this.channels) if (c.guild_id === d.id) this.channels.delete(id); } break;
      case 'GUILD_ROLE_CREATE': case 'GUILD_ROLE_UPDATE': this.guilds.get(d.guild_id)?.roles.set(d.role.id, d.role); break;
      case 'GUILD_ROLE_DELETE': this.guilds.get(d.guild_id)?.roles.delete(d.role_id); break;
      case 'GUILD_MEMBER_UPDATE': if (d.user?.id === this.user?.id) { const g = this.guilds.get(d.guild_id); if (g) g.member = d; } break;
      case 'CHANNEL_CREATE': case 'CHANNEL_UPDATE': case 'THREAD_CREATE': case 'THREAD_UPDATE':
        this.channels.set(d.id, { ...(this.channels.get(d.id) || {}), ...d }); break;
      case 'CHANNEL_DELETE': case 'THREAD_DELETE': this.channels.delete(d.id); break;
      case 'THREAD_LIST_SYNC': for (const th of d.threads || []) this.channels.set(th.id, { ...th, guild_id: d.guild_id }); break;
      case 'MESSAGE_CREATE': this.onMessage(d); break;
      case 'MESSAGE_ACK': {
        const r = this.readStates.get(d.channel_id) || { id: d.channel_id };
        r.last_message_id = d.message_id; r.mention_count = d.mention_count ?? 0;
        this.readStates.set(d.channel_id, r); break;
      }
      case 'RELATIONSHIP_ADD': case 'RELATIONSHIP_UPDATE': this.relationships.set(d.id, { ...(this.relationships.get(d.id) || {}), ...d }); break;
      case 'RELATIONSHIP_REMOVE': this.relationships.delete(d.id); break;
      case 'USER_GUILD_SETTINGS_UPDATE': this.guildSettings.set(d.guild_id ?? '@me', d); break;
      case 'USER_UPDATE': if (d.id === this.user?.id) this.user = { ...this.user, ...d }; break;
      case 'SESSIONS_REPLACE': this.sessions = d; break;
      case 'VOICE_STATE_UPDATE': {
        if (d.user_id === this.user?.id) { const k = d.guild_id ?? '@me'; if (d.channel_id) this.voice.set(k, d); else this.voice.delete(k); }
        const g = d.guild_id ? this.guilds.get(d.guild_id) : undefined;
        if (g) { g.voice_states = g.voice_states.filter((v: any) => v.user_id !== d.user_id); if (d.channel_id) g.voice_states.push(d); }
        break;
      }
      case 'INTERACTION_MODAL_CREATE': this.modals.unshift({ ...d, received_at: Date.now() }); this.modals.length = Math.min(this.modals.length, 20); break;
    }
    if (!NOISY.has(t)) {
      this.events.push({ seq: ++this.evSeq, t, at: Date.now(), d });
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.emit('dispatch', t, d);
  }

  private onMessage(m: any) {
    const c = this.channels.get(m.channel_id);
    if (c) c.last_message_id = m.id;
    const r = this.readStates.get(m.channel_id) || { id: m.channel_id, mention_count: 0 };
    if (m.author?.id === this.user?.id) { r.last_message_id = m.id; r.mention_count = 0; }
    else {
      const me = this.user?.id;
      const g = m.guild_id ? this.guilds.get(m.guild_id) : undefined;
      const myRoles: string[] = g?.member?.roles || [];
      const mentioned = !m.guild_id || m.mention_everyone || (m.mentions || []).some((u: any) => u.id === me) || (m.mention_roles || []).some((id: string) => myRoles.includes(id));
      if (mentioned) r.mention_count = (r.mention_count || 0) + 1;
    }
    this.readStates.set(m.channel_id, r);
  }

  // ---------------------------------------------------------------- helpers
  latestEventSeq() { return this.evSeq; }

  waitFor(types: string | string[], pred: (d: any, t: string) => boolean, timeoutMs: number): Promise<{ t: string; d: any } | null> {
    const set = new Set(Array.isArray(types) ? types : [types]);
    return new Promise((resolve) => {
      const on = (t: string, d: any) => { if (set.has(t) && pred(d, t)) { cleanup(); resolve({ t, d }); } };
      const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.off('dispatch', on); };
      this.on('dispatch', on);
    });
  }

  updatePresence(p: Partial<typeof this.presence>) {
    this.presence = { ...this.presence, ...p };
    this.send(3, { status: this.presence.status, since: this.presence.since || 0, activities: this.presence.activities, afk: this.presence.afk });
  }

  voiceStateUpdate(guildId: string | null, channelId: string | null, o: { self_mute?: boolean; self_deaf?: boolean; self_video?: boolean } = {}) {
    this.send(4, { guild_id: guildId, channel_id: channelId, self_mute: !!o.self_mute, self_deaf: !!o.self_deaf, self_video: !!o.self_video });
  }

  async requestMembers(guildIds: string | string[], o: { query?: string; limit?: number; user_ids?: string[]; presences?: boolean }, timeoutMs = 15_000) {
    const n = nonce().slice(-16);
    const members: any[] = []; const presences: any[] = []; let notFound: string[] = [];
    const done = new Promise<void>((resolve) => {
      const on = (t: string, d: any) => {
        if (t !== 'GUILD_MEMBERS_CHUNK' || d.nonce !== n) return;
        members.push(...(d.members || []).map((m: any) => ({ ...m, guild_id: d.guild_id })));
        presences.push(...(d.presences || []));
        if (d.not_found) notFound = notFound.concat(d.not_found);
        if (d.chunk_index + 1 >= d.chunk_count) { cleanup(); resolve(); }
      };
      const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.off('dispatch', on); };
      this.on('dispatch', on);
    });
    const d: any = { guild_id: guildIds, presences: !!o.presences, nonce: n };
    if (o.user_ids?.length) d.user_ids = o.user_ids; else { d.query = o.query ?? ''; d.limit = o.limit ?? (d.query ? 100 : 0); }
    this.send(8, d);
    await done;
    return { members, presences, not_found: notFound };
  }

  /** My effective permissions in a guild or channel (bigint), computed from the cached roles and overwrites. */
  permissions(guildId: string, channelId?: string): bigint | undefined {
    const g = this.guilds.get(guildId);
    if (!g || !this.user) return undefined;
    if (g.owner_id === this.user.id) return ALL_PERMISSIONS;
    const myRoles: string[] = g.member?.roles || [];
    let base = BigInt(g.roles.get(guildId)?.permissions ?? 0);
    for (const id of myRoles) base |= BigInt(g.roles.get(id)?.permissions ?? 0);
    if (base & PERMISSIONS.ADMINISTRATOR) return ALL_PERMISSIONS;
    if (!channelId) return base;
    let ch = this.channels.get(channelId);
    if (ch && [10, 11, 12].includes(ch.type) && ch.parent_id) ch = this.channels.get(ch.parent_id) ?? ch;
    if (!ch) return base;
    let p = base;
    const ows: any[] = ch.permission_overwrites || [];
    const everyone = ows.find((o) => o.id === guildId);
    if (everyone) p = (p & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
    let allow = 0n, deny = 0n;
    for (const o of ows) if (o.type === 0 && myRoles.includes(o.id)) { allow |= BigInt(o.allow); deny |= BigInt(o.deny); }
    p = (p & ~deny) | allow;
    const mine = ows.find((o) => o.type === 1 && o.id === this.user.id);
    if (mine) p = (p & ~BigInt(mine.deny)) | BigInt(mine.allow);
    return p;
  }

  canView(ch: any): boolean {
    if (!ch.guild_id) return true;
    const p = this.permissions(ch.guild_id, ch.id);
    return p === undefined ? true : (p & PERMISSIONS.VIEW_CHANNEL) !== 0n;
  }

  isMuted(ch: any): boolean {
    const s = this.guildSettings.get(ch.guild_id ?? '@me');
    if (!s) return false;
    const now = Date.now();
    const active = (m: boolean, cfg: any) => m && (!cfg?.end_time || Date.parse(cfg.end_time) > now);
    if (ch.guild_id && active(s.muted, s.mute_config)) return true;
    const ov = (s.channel_overrides || []).find((o: any) => o.channel_id === ch.id || o.channel_id === ch.parent_id);
    return !!(ov && active(ov.muted, ov.mute_config));
  }

  unread(ch: any): boolean {
    if (!ch.last_message_id) return false;
    const r = this.readStates.get(ch.id);
    return cmpId(ch.last_message_id, r?.last_message_id) > 0;
  }
}

export const gateway = new Gateway();

/** Start the gateway in the background (if enabled and logged in). */
export function startGatewayInBackground() {
  if (!settings.gateway || !currentAccount()?.token) return;
  gateway.ensure(60_000).catch(() => { /* status/error kept on the object */ });
}

export async function sessionId(): Promise<string> {
  if (settings.gateway) {
    try { await gateway.ensure(); if (gateway.sessionId) return gateway.sessionId; } catch { /* fall through */ }
  }
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export { sleep };
