/* QR-code login ("remote auth"): scan with the Discord phone app, receive a user token. No password handled here. */
import crypto from 'node:crypto';
import WebSocket from 'ws';
import QRCode from 'qrcode';
import { REMOTE_AUTH_URL, saveAccount } from '../config.js';
import { rest } from './rest.js';
import { userAgent } from './client-props.js';

export interface QrLogin {
  id: string;
  state: 'connecting' | 'waiting_for_scan' | 'scanned' | 'done' | 'cancelled' | 'expired' | 'error';
  url?: string;
  qrPng?: string; // base64 PNG
  qrText?: string; // terminal rendering
  user?: { id: string; username: string; discriminator: string; avatar: string };
  error?: string;
  startedAt: number;
  expiresAt?: number;
  done: Promise<void>;
}

const logins = new Map<string, QrLogin>();
let latest: string | undefined;

export function getLogin(id?: string) { return logins.get(id ?? latest ?? ''); }

export function startQrLogin(opts: { save?: boolean } = {}): Promise<QrLogin> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const decrypt = (b64: string) => crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(b64, 'base64'));
  const id = crypto.randomUUID().slice(0, 8);
  let resolveDone!: () => void;
  const login: QrLogin = { id, state: 'connecting', startedAt: Date.now(), done: new Promise((r) => { resolveDone = r; }) };
  logins.set(id, login); latest = id;

  return new Promise((resolveStart, rejectStart) => {
    const ws = new WebSocket(REMOTE_AUTH_URL, { headers: { Origin: 'https://discord.com', 'User-Agent': userAgent } });
    let hb: NodeJS.Timeout | undefined;
    let started = false;
    const finish = (state: QrLogin['state'], error?: string) => {
      if (['done', 'cancelled', 'expired', 'error'].includes(login.state)) return;
      login.state = state; login.error = error;
      clearInterval(hb);
      try { ws.close(); } catch { /* ignore */ }
      resolveDone();
      if (!started) { started = true; error ? rejectStart(new Error(error)) : resolveStart(login); }
    };
    ws.on('message', async (raw) => {
      let p: any;
      try { p = JSON.parse(raw.toString()); } catch { return; }
      try {
        switch (p.op) {
          case 'hello':
            hb = setInterval(() => ws.send(JSON.stringify({ op: 'heartbeat' })), p.heartbeat_interval);
            login.expiresAt = Date.now() + (p.timeout_ms || 120_000);
            ws.send(JSON.stringify({ op: 'init', encoded_public_key: spki.toString('base64') }));
            break;
          case 'nonce_proof': {
            const n = decrypt(p.encrypted_nonce);
            ws.send(JSON.stringify({ op: 'nonce_proof', nonce: n.toString('base64url') }));
            break;
          }
          case 'pending_remote_init': {
            const expect = crypto.createHash('sha256').update(spki).digest('base64url');
            if (p.fingerprint !== expect) { finish('error', 'Fingerprint mismatch from Discord; try again.'); return; }
            login.url = `https://discord.com/ra/${p.fingerprint}`;
            login.qrPng = (await QRCode.toBuffer(login.url, { width: 360, margin: 2 })).toString('base64');
            login.qrText = await QRCode.toString(login.url, { type: 'terminal', small: true });
            login.state = 'waiting_for_scan';
            if (!started) { started = true; resolveStart(login); }
            break;
          }
          case 'pending_ticket': {
            const [uid, discriminator, avatar, ...name] = decrypt(p.encrypted_user_payload).toString('utf8').split(':');
            login.user = { id: uid, discriminator, avatar, username: name.join(':') };
            login.state = 'scanned';
            break;
          }
          case 'pending_login': {
            const r = await rest.post<{ encrypted_token: string }>('/users/@me/remote-auth/login', { ticket: p.ticket }, { noAuth: true });
            const token = decrypt(r.encrypted_token).toString('utf8');
            if (opts.save !== false) {
              saveAccount({ token, type: 'user', user: login.user ? { id: login.user.id, username: login.user.username } : undefined });
            }
            (login as any).token = token;
            finish('done');
            break;
          }
          case 'cancel': finish('cancelled', 'Login was cancelled on the phone.'); break;
        }
      } catch (e) { finish('error', (e as Error).message); }
    });
    ws.on('close', (code) => {
      if (login.state === 'done') return;
      if (code === 4003) finish('expired', 'The QR code expired. Start again.');
      else finish('error', `Remote auth connection closed (${code}).`);
    });
    ws.on('error', (e) => finish('error', `Could not reach Discord remote auth: ${e.message}`));
  });
}
