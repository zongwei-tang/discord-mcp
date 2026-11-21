/* Using bots like a person: slash commands, context-menu commands, buttons, select menus, modals. */
import { fmtMessage } from '../../discord/format.js';
import { gateway, sessionId } from '../../discord/gateway.js';
import { rest } from '../../discord/rest.js';
import { nonce } from '../../discord/util.js';
import { filesParam } from '../spec.js';
import { defineTool, z } from '../registry.js';
import { channelRef, fetchMessage, getChannel } from './common.js';

const OPTION_TYPES: Record<number, string> = { 1: 'subcommand', 2: 'subcommand_group', 3: 'string', 4: 'integer', 5: 'boolean', 6: 'user', 7: 'channel', 8: 'role', 9: 'mentionable', 10: 'number', 11: 'attachment' };

async function commandIndex(channelId: string): Promise<{ ch: any; index: any }> {
  const ch = await getChannel(channelId);
  const index = ch.guild_id
    ? await rest.get(`/guilds/${ch.guild_id}/application-command-index`)
    : await rest.get(`/channels/${channelId}/application-command-index`);
  // user-installed apps work everywhere
  try {
    const u = await rest.get('/users/@me/application-command-index');
    index.applications = [...(index.applications || []), ...(u.applications || []).filter((x: any) => !(index.applications || []).some((y: any) => y.id === x.id))];
    index.application_commands = [...(index.application_commands || []), ...(u.application_commands || []).filter((x: any) => !(index.application_commands || []).some((y: any) => y.id === x.id))];
  } catch { /* optional */ }
  return { ch, index };
}

function describeOptions(opts: any[] | undefined): any {
  return opts?.map((o) => ({
    name: o.name, type: OPTION_TYPES[o.type] ?? o.type, required: o.required || undefined, description: o.description,
    choices: o.choices?.map((c: any) => `${c.name}=${c.value}`), autocomplete: o.autocomplete || undefined,
    options: [1, 2].includes(o.type) ? describeOptions(o.options) : undefined,
  }));
}

defineTool({
  name: 'list_commands', category: 'interactions', readOnly: true,
  description: 'List slash commands and context-menu commands you can use in a channel/DM (from all bots there and your user-installed apps).',
  shape: { channel_id: z.string(), query: z.string().optional().describe('Filter by command or app name'), application_id: z.string().optional() },
  handler: async (a) => {
    const { index } = await commandIndex(channelRef(a.channel_id).channel_id);
    const apps = new Map((index.applications || []).map((x: any) => [x.id, x.name]));
    const q = a.query?.toLowerCase();
    return (index.application_commands || [])
      .filter((c: any) => (!a.application_id || c.application_id === a.application_id) && (!q || c.name.includes(q) || String(apps.get(c.application_id) ?? '').toLowerCase().includes(q)))
      .map((c: any) => ({ app: apps.get(c.application_id), application_id: c.application_id, id: c.id, name: c.name, kind: ({ 1: 'slash', 2: 'user_context', 3: 'message_context', 4: 'activity' } as any)[c.type ?? 1], description: c.description || undefined, options: describeOptions(c.options) }));
  },
});

function buildOptions(defs: any[] = [], values: Record<string, unknown>, fileCount: number): any[] {
  const out: any[] = [];
  for (const d of defs) {
    if (!(d.name in values)) { if (d.required) throw new Error(`Missing required option "${d.name}" (${OPTION_TYPES[d.type]})`); continue; }
    let v: any = values[d.name];
    if (d.type === 4) v = parseInt(String(v), 10);
    else if (d.type === 10) v = Number(v);
    else if (d.type === 5) v = v === true || v === 'true';
    else if (d.type === 11) { const i = Number(v); if (!(i >= 0 && i < fileCount)) throw new Error(`Option ${d.name} is an attachment: pass files and set it to the file index (0-based)`); v = String(i); }
    else v = String(v).replace(/^<[@#]&?!?(\d+)>$/, '$1');
    out.push({ type: d.type, name: d.name, value: v });
  }
  return out;
}

/** Send an interaction and collect what comes back (listening starts before sending, so fast replies aren't missed). */
async function interact(body: any, o: { channelId: string; appId: string; waitS: number; messageId?: string; files?: any[] }) {
  const n: string = body.nonce;
  const live = o.waitS > 0 && gateway.status === 'ready';
  let interactionId: string | undefined; let acked = false; let failed: any; let modal: any; let reply: any;
  const appMsgs: any[] = [];
  let wake = () => {};
  const on = (t: string, d: any) => {
    if ((t === 'INTERACTION_CREATE' || t === 'INTERACTION_SUCCESS') && d?.nonce === n) { interactionId = d.id; acked = true; }
    else if (t === 'INTERACTION_FAILURE' && d?.nonce === n) failed = d;
    else if ((t === 'INTERACTION_MODAL_CREATE' || t === 'INTERACTION_IFRAME_MODAL_CREATE') && d?.nonce === n) modal = d;
    else if ((t === 'MESSAGE_CREATE' || t === 'MESSAGE_UPDATE') && d?.channel_id === o.channelId && (d.author?.id === o.appId || d.application_id === o.appId)) appMsgs.push({ t, d });
    else return;
    const mine = appMsgs.filter(({ t: tt, d: m }) => (interactionId && (m.interaction_metadata?.id === interactionId || m.interaction?.id === interactionId)) || (o.messageId && m.id === o.messageId && tt === 'MESSAGE_UPDATE'));
    if (mine.length) reply = mine[mine.length - 1].d;
    wake();
  };
  if (live) gateway.on('dispatch', on);
  try {
    await rest.post('/interactions', body, { files: o.files });
    if (!live) return { status: 'sent', note: o.waitS > 0 ? 'Live connection not ready, so the reply was not awaited; check with read_messages.' : undefined };
    const deadline = Date.now() + o.waitS * 1000;
    const done = () => failed || modal || (reply && !(reply.flags & 128));
    while (!done() && Date.now() < deadline) await new Promise<void>((r) => { wake = r; setTimeout(r, Math.min(500, Math.max(0, deadline - Date.now()))); });
  } finally {
    if (live) gateway.off('dispatch', on);
  }
  if (failed) return { status: 'failed', note: 'The app did not respond in time or rejected the interaction.' };
  if (modal) return { status: 'modal', modal: { id: modal.id, custom_id: modal.custom_id, title: modal.title, inputs: modalInputs(modal.components) }, next: 'Fill it in with submit_modal.' };
  if (reply) return { status: reply.flags & 128 ? 'thinking' : 'ok', response: fmtMessage(reply, { full: true }) };
  return { status: acked ? 'acknowledged' : 'sent', note: 'No reply seen yet; check with read_messages.' };
}

function modalInputs(components: any[] = [], out: any[] = []): any[] {
  for (const c of components) {
    if (c.type === 4) out.push({ custom_id: c.custom_id, label: c.label, style: c.style === 2 ? 'paragraph' : 'short', required: c.required ?? true, value: c.value, placeholder: c.placeholder, max_length: c.max_length });
    else if ([3, 5, 6, 7, 8].includes(c.type)) out.push({ custom_id: c.custom_id, select: true, options: c.options?.map((o: any) => o.value), min: c.min_values, max: c.max_values });
    if (c.components) modalInputs(c.components, out);
    if (c.component) modalInputs([c.component], out);
  }
  return out;
}

defineTool({
  name: 'run_slash_command', category: 'interactions',
  description: 'Run a bot\'s slash command in a channel/DM, like typing /command. command can include subcommands ("music play"). options are by name. Returns the bot\'s reply (or a modal to fill).',
  shape: {
    channel_id: z.string(), command: z.string().describe('Command name, with subcommand group/subcommand separated by spaces, e.g. "imagine" or "config set"'),
    options: z.record(z.string(), z.any()).optional().describe('Option values by name, e.g. {"prompt": "a cat"}; users/channels/roles by ID; attachments by file index'),
    application_id: z.string().optional().describe('Which app, if several have this command'), files: filesParam,
    wait_seconds: z.number().optional().describe('How long to wait for the reply (default 15, 0 = don\'t wait)'),
  },
  handler: async (a) => {
    const channelId = channelRef(a.channel_id).channel_id;
    const { ch, index } = await commandIndex(channelId);
    const [root, ...sub] = a.command.replace(/^\//, '').trim().split(/\s+/);
    const cands = (index.application_commands || []).filter((c: any) => c.name === root && (c.type ?? 1) === 1 && (!a.application_id || c.application_id === a.application_id));
    if (!cands.length) throw new Error(`No slash command "/${root}" here. Use list_commands.`);
    if (cands.length > 1) throw new Error(`Several apps have /${root}: ${cands.map((c: any) => c.application_id).join(', ')}. Pass application_id.`);
    const cmd = cands[0];
    const fileCount = a.files?.length ?? 0;
    let options: any[];
    let defs = cmd.options || [];
    const chain: any[] = [];
    for (const s of sub) {
      const d = defs.find((o: any) => o.name === s && (o.type === 1 || o.type === 2));
      if (!d) throw new Error(`"${s}" is not a subcommand of /${root}. Available: ${defs.filter((o: any) => o.type <= 2).map((o: any) => o.name).join(', ')}`);
      chain.push(d); defs = d.options || [];
    }
    if (defs.some((o: any) => o.type === 1 || o.type === 2)) throw new Error(`/${a.command} needs a subcommand: ${defs.map((o: any) => o.name).join(', ')}`);
    options = buildOptions(defs, a.options || {}, fileCount);
    for (let i = chain.length - 1; i >= 0; i--) options = [{ type: chain[i].type, name: chain[i].name, options }];
    const n = nonce();
    const data: any = { version: cmd.version, id: cmd.id, name: cmd.name, type: 1, options, application_command: cmd, attachments: [] };
    return interact({ type: 2, application_id: cmd.application_id, guild_id: ch.guild_id, channel_id: channelId, session_id: await sessionId(), data, nonce: n, analytics_location: 'slash_ui' },
      { channelId, appId: cmd.application_id, waitS: a.wait_seconds ?? 15, files: a.files });
  },
});

defineTool({
  name: 'run_context_command', category: 'interactions',
  description: 'Run an "Apps" right-click command on a user or a message (context-menu command).',
  shape: {
    channel_id: z.string(), command: z.string().describe('Command name as shown in the Apps menu'), target_id: z.string().describe('User ID (user command) or message ID (message command)'),
    application_id: z.string().optional(), wait_seconds: z.number().optional(),
  },
  handler: async (a) => {
    const channelId = channelRef(a.channel_id).channel_id;
    const { ch, index } = await commandIndex(channelId);
    const cands = (index.application_commands || []).filter((c: any) => c.name.toLowerCase() === a.command.toLowerCase() && (c.type === 2 || c.type === 3) && (!a.application_id || c.application_id === a.application_id));
    if (!cands.length) throw new Error(`No context command "${a.command}". Use list_commands.`);
    const cmd = cands[0];
    const n = nonce();
    return interact({ type: 2, application_id: cmd.application_id, guild_id: ch.guild_id, channel_id: channelId, session_id: await sessionId(), nonce: n,
      data: { version: cmd.version, id: cmd.id, name: cmd.name, type: cmd.type, target_id: a.target_id, options: [], application_command: cmd, attachments: [] } },
    { channelId, appId: cmd.application_id, waitS: a.wait_seconds ?? 15 });
  },
});

function findComponent(cs: any[] | undefined, pred: (c: any) => boolean): any {
  for (const c of cs || []) {
    if (pred(c)) return c;
    const sub = findComponent(c.components, pred) ?? (c.accessory ? findComponent([c.accessory], pred) : undefined);
    if (sub) return sub;
  }
  return undefined;
}

async function componentInteraction(a: any, kind: 'button' | 'select') {
  const l = channelRef(a.message);
  const channelId = l.message_id ? l.channel_id : channelRef(a.channel_id ?? '').channel_id;
  const messageId = l.message_id ?? a.message;
  if (!channelId) throw new Error('Need a message link or channel_id');
  const m = await fetchMessage(channelId, messageId);
  const want = (c: any) => kind === 'button'
    ? c.type === 2 && (a.custom_id ? c.custom_id === a.custom_id : (c.label ?? c.emoji?.name ?? '').toLowerCase() === String(a.label ?? '').toLowerCase())
    : [3, 5, 6, 7, 8].includes(c.type) && (!a.custom_id || c.custom_id === a.custom_id);
  const comp = findComponent(m.components, want);
  if (!comp) throw new Error(`No matching ${kind} on that message. Components: ${JSON.stringify(fmtMessage(m).components ?? [])}`);
  if (comp.url) return { link_button: true, url: comp.url, note: 'This is a link button; open the URL instead.' };
  if (comp.disabled) throw new Error('That component is disabled.');
  const ch = await getChannel(channelId).catch(() => ({}));
  const appId = m.application_id ?? m.author?.id;
  const n = nonce();
  const data: any = kind === 'button' ? { component_type: 2, custom_id: comp.custom_id } : { component_type: comp.type, custom_id: comp.custom_id, type: comp.type, values: a.values };
  return interact({ type: 3, nonce: n, guild_id: ch.guild_id ?? m.guild_id, channel_id: channelId, message_flags: m.flags ?? 0, message_id: m.id, application_id: appId, session_id: await sessionId(), data },
    { channelId, appId, waitS: a.wait_seconds ?? 10, messageId: m.id });
}

defineTool({
  name: 'click_button', category: 'interactions',
  description: 'Click a button on a bot message (by label or custom_id). Returns the bot\'s response or a modal to fill.',
  shape: {
    message: z.string().describe('Message link, or message ID with channel_id'), channel_id: z.string().optional(),
    label: z.string().optional().describe('Button label (or emoji)'), custom_id: z.string().optional(), wait_seconds: z.number().optional(),
  },
  handler: (a) => componentInteraction(a, 'button'),
});

defineTool({
  name: 'select_menu_option', category: 'interactions',
  description: 'Choose option(s) in a select menu on a bot message (values = option values, or user/role/channel IDs for those menus).',
  shape: {
    message: z.string(), channel_id: z.string().optional(), custom_id: z.string().optional().describe('Which menu (default: the first)'),
    values: z.array(z.string()), wait_seconds: z.number().optional(),
  },
  handler: (a) => componentInteraction(a, 'select'),
});

defineTool({
  name: 'list_pending_modals', category: 'interactions', readOnly: true,
  description: 'Forms (modals) bots opened for you recently and their input fields.',
  shape: {},
  handler: async () => gateway.modals.map((m) => ({ id: m.id, custom_id: m.custom_id, title: m.title, application_id: m.application?.id, channel_id: m.channel_id, received: new Date(m.received_at).toISOString(), inputs: modalInputs(m.components) })),
});

function fillModal(components: any[], values: Record<string, unknown>): any[] {
  return components.map((c) => {
    const out: any = { type: c.type };
    if (c.id !== undefined) out.id = c.id;
    if (c.custom_id) out.custom_id = c.custom_id;
    if (c.type === 4) out.value = String(values[c.custom_id] ?? c.value ?? '');
    if ([3, 5, 6, 7, 8].includes(c.type)) { const v = values[c.custom_id]; out.values = Array.isArray(v) ? v.map(String) : v !== undefined ? [String(v)] : []; }
    if (c.components) out.components = fillModal(c.components, values);
    if (c.component) out.component = fillModal([c.component], values)[0];
    return out;
  });
}

defineTool({
  name: 'submit_modal', category: 'interactions',
  description: 'Fill in and submit a bot form (modal). values maps each input custom_id to text (or a list for selects). Defaults to the most recent modal.',
  shape: { values: z.record(z.string(), z.any()), modal_id: z.string().optional(), wait_seconds: z.number().optional() },
  handler: async (a) => {
    const m = a.modal_id ? gateway.modals.find((x) => x.id === a.modal_id) : gateway.modals[0];
    if (!m) throw new Error('No pending modal. Trigger one with run_slash_command / click_button first.');
    const n = nonce();
    const appId = m.application?.id;
    gateway.modals = gateway.modals.filter((x) => x !== m);
    return interact({ type: 5, application_id: appId, channel_id: m.channel_id, guild_id: m.guild_id, session_id: await sessionId(), nonce: n,
      data: { id: m.id, custom_id: m.custom_id, components: fillModal(m.components, a.values) } },
    { channelId: m.channel_id, appId, waitS: a.wait_seconds ?? 10 });
  },
});
