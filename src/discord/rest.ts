/* Minimal Discord HTTP client: auth, client headers, rate limits, retries, multipart uploads. */
import fs from 'node:fs';
import path from 'node:path';
import { API_BASE, VERSION, currentAccount, settings, type SavedAccount } from '../config.js';
import { superProperties, userAgent } from './client-props.js';

export class DiscordError extends Error {
  constructor(message: string, public status: number, public code?: number, public body?: unknown) { super(message); }
}

export class NotLoggedIn extends Error {
  constructor() { super('Not logged in to Discord. Call discord_login (QR code, scan it with the Discord phone app) or discord_login_token, or set DISCORD_TOKEN.'); }
}

/** A file to upload: a local path, an http(s) URL, or base64 data. */
export interface FileInput {
  path?: string;
  url?: string;
  data_base64?: string;
  filename?: string;
  description?: string;
  spoiler?: boolean;
  content_type?: string;
}

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  files?: FileInput[];
  /** Field name for files: "files[n]" (default) or e.g. "file" for stickers. */
  fileField?: string;
  /** Send body as plain multipart form fields instead of payload_json. */
  formFields?: boolean;
  reason?: string;
  /** Skip the Authorization header. */
  noAuth?: boolean;
  headers?: Record<string, string>;
  account?: SavedAccount;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function routeKey(method: string, p: string) {
  // keep the major parameter (channel/guild/webhook id), collapse other ids
  const m = p.match(/^\/(channels|guilds|webhooks)\/(\d+)/);
  const rest = p.replace(/\/\d{15,22}/g, '/:id');
  return `${method} ${m ? `${m[1]}:${m[2]}` : ''} ${rest}`;
}

function encodeQuery(q?: Record<string, unknown>) {
  if (!q) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) sp.append(k, String(x));
    else if (typeof v === 'object') sp.append(k, JSON.stringify(v));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  txt: 'text/plain', json: 'application/json', pdf: 'application/pdf', zip: 'application/zip', lottie: 'application/json',
};
export function mimeOf(name: string) { return MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream'; }

export async function loadFile(f: FileInput): Promise<{ data: Buffer; filename: string; type: string }> {
  let data: Buffer; let filename = f.filename; let type = f.content_type;
  if (f.path) {
    const p = f.path.replace(/^~(?=\/|$)/, process.env.HOME || '');
    data = fs.readFileSync(p);
    filename ??= path.basename(p);
  } else if (f.url) {
    const res = await fetch(f.url, { headers: { 'User-Agent': userAgent } });
    if (!res.ok) throw new Error(`Could not download ${f.url}: HTTP ${res.status}`);
    data = Buffer.from(await res.arrayBuffer());
    type ??= res.headers.get('content-type')?.split(';')[0] || undefined;
    filename ??= decodeURIComponent(new URL(f.url).pathname.split('/').pop() || 'file');
  } else if (f.data_base64) {
    const m = f.data_base64.match(/^data:([^;]+);base64,(.*)$/s);
    data = Buffer.from(m ? m[2] : f.data_base64, 'base64');
    type ??= m?.[1];
    filename ??= 'file';
  } else {
    throw new Error('A file needs one of: path, url, data_base64');
  }
  type ??= mimeOf(filename);
  if (f.spoiler && !filename.startsWith('SPOILER_')) filename = `SPOILER_${filename}`;
  return { data, filename, type };
}

/** Turn a local path / URL / data URI / raw base64 into a data URI (avatars, icons, emoji, sounds…). */
export async function toDataUri(v: unknown): Promise<unknown> {
  if (typeof v !== 'string' || !v) return v;
  if (v.startsWith('data:')) return v;
  if (/^https?:\/\//i.test(v)) {
    const f = await loadFile({ url: v });
    return `data:${f.type};base64,${f.data.toString('base64')}`;
  }
  const p = v.replace(/^~(?=\/|$)/, process.env.HOME || '');
  if (fs.existsSync(p)) {
    const f = await loadFile({ path: p });
    return `data:${f.type};base64,${f.data.toString('base64')}`;
  }
  return v; // assume already base64 / hash
}

function flattenErrors(e: any, prefix = ''): string[] {
  if (!e || typeof e !== 'object') return [];
  if (Array.isArray(e._errors)) return e._errors.map((x: any) => `${prefix || 'body'}: ${x.message} (${x.code})`);
  return Object.entries(e).flatMap(([k, v]) => flattenErrors(v, prefix ? `${prefix}.${k}` : k));
}

function explain(status: number, body: any, method: string, p: string): string {
  if (body && typeof body === 'object') {
    if (body.captcha_key || body.captcha_sitekey) {
      if (p.includes('/remote-auth/login')) {
        return 'Discord blocked the QR login from this machine\'s IP with a captcha (common on cloud servers). Log in on your own computer instead (`discord-mcp login`, then `discord-mcp token` prints the token), and give the token to this server: set DISCORD_TOKEN, or call discord_login_token.';
      }
      return `Discord wants a captcha for this action (${method} ${p}). Do it once in the Discord app or website, then try again later.`;
    }
    const details = flattenErrors(body.errors);
    const base = body.message ? `${body.message}${body.code ? ` (code ${body.code})` : ''}` : JSON.stringify(body).slice(0, 500);
    const hint = status === 401 ? ' — the token is invalid or was logged out. Log in again (discord_login).'
      : status === 403 ? ' — your account lacks permission for this, or the endpoint is not available to this account type.'
      : status === 404 ? ' — check the IDs (guild/channel/message/user) are right.' : '';
    return `${method} ${p} failed: HTTP ${status} ${base}${details.length ? `\n${details.join('\n')}` : ''}${hint}`;
  }
  return `${method} ${p} failed: HTTP ${status} ${String(body ?? '').slice(0, 300)}`;
}

export class Rest {
  private buckets = new Map<string, { remaining: number; resetAt: number }>();
  private globalUntil = 0;

  account(acc?: SavedAccount): SavedAccount {
    const a = acc ?? currentAccount();
    if (!a?.token) throw new NotLoggedIn();
    return a;
  }

  headers(acc: SavedAccount | undefined, extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {};
    const isBot = acc?.type === 'bot';
    if (isBot) {
      h['User-Agent'] = `DiscordBot (https://github.com/zongwei-tang/discord-mcp, ${VERSION})`;
    } else {
      h['User-Agent'] = userAgent;
      h['X-Super-Properties'] = superProperties();
      h['X-Discord-Locale'] = settings.locale;
      h['X-Discord-Timezone'] = settings.timezone;
      h['X-Debug-Options'] = 'bugReporterEnabled';
      h['Accept-Language'] = `${settings.locale},${settings.locale.split('-')[0]};q=0.9`;
      h['Origin'] = 'https://discord.com';
      h['Referer'] = 'https://discord.com/channels/@me';
    }
    if (acc) h['Authorization'] = isBot ? `Bot ${acc.token}` : acc.token;
    return { ...h, ...extra };
  }

  async request<T = any>(method: string, p: string, o: RequestOptions = {}): Promise<T> {
    method = method.toUpperCase();
    const acc = o.noAuth ? undefined : this.account(o.account);
    const url = `${API_BASE}${p}${encodeQuery(o.query)}`;
    const key = routeKey(method, p);

    let body: BodyInit | undefined;
    const extra: Record<string, string> = { ...(o.headers || {}) };
    if (o.reason) extra['X-Audit-Log-Reason'] = encodeURIComponent(o.reason);
    if (o.files?.length) {
      const fd = new FormData();
      const payload: any = o.body && typeof o.body === 'object' ? { ...(o.body as object) } : {};
      const loaded = await Promise.all(o.files.map(loadFile));
      if (o.formFields) {
        for (const [k, v] of Object.entries(payload)) if (v !== undefined && v !== null) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        const f = loaded[0];
        fd.append(o.fileField || 'file', new Blob([new Uint8Array(f.data)], { type: f.type }), f.filename);
      } else {
        const attachments = Array.isArray(payload.attachments) ? [...payload.attachments] : [];
        loaded.forEach((f, i) => {
          attachments.push({ id: attachments.length, filename: f.filename, ...(o.files![i].description ? { description: o.files![i].description } : {}) });
          fd.append(`files[${attachments.length - 1}]`, new Blob([new Uint8Array(f.data)], { type: f.type }), f.filename);
        });
        payload.attachments = attachments;
        fd.append('payload_json', JSON.stringify(payload));
      }
      body = fd;
    } else if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      extra['Content-Type'] = 'application/json';
    }

    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const wait = Math.max(this.globalUntil - now, 0, (() => { const b = this.buckets.get(key); return b && b.remaining <= 0 ? b.resetAt - now : 0; })());
      if (wait > 0) await sleep(Math.min(wait, 60_000));

      let res: Response;
      try {
        res = await fetch(url, { method, headers: this.headers(acc, extra), body, signal: AbortSignal.timeout(120_000) });
      } catch (e) {
        if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
        throw new Error(`${method} ${p}: network error: ${(e as Error).message}`);
      }

      const rem = res.headers.get('x-ratelimit-remaining');
      const after = res.headers.get('x-ratelimit-reset-after');
      if (rem !== null && after !== null) this.buckets.set(key, { remaining: Number(rem), resetAt: Date.now() + Number(after) * 1000 });

      if (res.status === 429) {
        const j: any = await res.json().catch(() => ({}));
        const retry = Number(j.retry_after ?? res.headers.get('retry-after') ?? 1) * 1000;
        if (j.global) this.globalUntil = Date.now() + retry;
        if (attempt < 4 && retry <= 65_000) { await sleep(retry + 50); continue; }
        throw new DiscordError(`Rate limited by Discord for ${Math.ceil(retry / 1000)}s on ${method} ${p}. Try again later.`, 429, j.code, j);
      }
      if (res.status >= 500 && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }

      if (res.status === 204) return { ok: true } as T;
      const ct = res.headers.get('content-type') || '';
      const parsed: any = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
      if (!res.ok) throw new DiscordError(explain(res.status, parsed, method, p), res.status, parsed?.code, parsed);
      if (res.status === 202 && parsed && typeof parsed === 'object' && parsed.retry_after && attempt < 3) {
        // search index not ready yet
        await sleep(Math.min(Number(parsed.retry_after) * 1000, 10_000) || 2000);
        continue;
      }
      return (parsed ?? { ok: true }) as T;
    }
  }

  get<T = any>(p: string, query?: Record<string, unknown>, o: RequestOptions = {}) { return this.request<T>('GET', p, { ...o, query }); }
  post<T = any>(p: string, body?: unknown, o: RequestOptions = {}) { return this.request<T>('POST', p, { ...o, body }); }
  patch<T = any>(p: string, body?: unknown, o: RequestOptions = {}) { return this.request<T>('PATCH', p, { ...o, body }); }
  put<T = any>(p: string, body?: unknown, o: RequestOptions = {}) { return this.request<T>('PUT', p, { ...o, body }); }
  delete<T = any>(p: string, o: RequestOptions = {}) { return this.request<T>('DELETE', p, o); }
}

export const rest = new Rest();
