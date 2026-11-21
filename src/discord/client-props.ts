/* Client identity sent with every request ("super properties"), matching the Discord web client. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, WEB_BASE, settings } from '../config.js';

const FALLBACK_BUILD = 678976; // stable web build seen 2026-11
const CACHE = path.join(HOME, 'build.json');
const TTL = 12 * 3600_000;

export const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${settings.chromeVersion} Safari/537.36`;

let build = FALLBACK_BUILD;
const launchId = crypto.randomUUID();
const heartbeatSession = crypto.randomUUID();

export function properties(): Record<string, unknown> {
  return {
    os: 'Windows',
    browser: 'Chrome',
    device: '',
    system_locale: settings.locale,
    has_client_mods: false,
    browser_user_agent: userAgent,
    browser_version: settings.chromeVersion,
    os_version: '10',
    referrer: '',
    referring_domain: '',
    referrer_current: '',
    referring_domain_current: '',
    release_channel: 'stable',
    client_build_number: build,
    client_event_source: null,
    client_launch_id: launchId,
    client_heartbeat_session_id: heartbeatSession,
    client_app_state: 'focused',
  };
}

let superProps = '';
export function superProperties(): string {
  if (!superProps) superProps = Buffer.from(JSON.stringify(properties())).toString('base64');
  return superProps;
}

export function buildNumber() { return build; }

/** Pick up the current web client build number (cached for 12h). Never throws. */
export async function refreshBuildNumber(): Promise<number> {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (c.build && Date.now() - c.at < TTL) { build = c.build; superProps = ''; return build; }
  } catch { /* no cache */ }
  try {
    const res = await fetch(`${WEB_BASE}/app`, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(8000) });
    const html = await res.text();
    const m = html.match(/BUILD_NUMBER"\s*:\s*"?(\d{5,})/) || html.match(/build_number["']?\s*[:=]\s*["']?(\d{5,})/);
    if (m) {
      build = Number(m[1]);
      superProps = '';
      try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify({ build, at: Date.now() })); } catch { /* ignore */ }
    }
  } catch { /* offline: keep fallback */ }
  return build;
}
