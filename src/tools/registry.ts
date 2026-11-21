/* Tool registry: every tool (declarative endpoint or hand-written) is a ToolDef; registerAll() exposes them over MCP. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { settings } from '../config.js';
import { prune } from '../discord/util.js';

export type Shape = Record<string, z.ZodType>;

export interface Image { __image: { data: string; mimeType: string }; text?: string }

export interface ToolDef {
  name: string;
  category: string;
  description: string;
  shape: Shape;
  handler: (args: any) => Promise<unknown>;
  readOnly?: boolean;
  destructive?: boolean;
  /** Accept unknown arguments (they are passed through to Discord). */
  loose?: boolean;
  /** Usable before logging in. */
  noAuth?: boolean;
}

export const tools: ToolDef[] = [];
const names = new Set<string>();

export function defineTool(t: ToolDef) {
  if (names.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
  names.add(t.name);
  tools.push(t);
}

export function render(out: unknown): { content: any[] } {
  if (out && typeof out === 'object' && '__image' in (out as any)) {
    const img = (out as Image).__image;
    const content: any[] = [{ type: 'image', data: img.data, mimeType: img.mimeType }];
    if ((out as Image).text) content.unshift({ type: 'text', text: (out as Image).text });
    return { content };
  }
  let text = typeof out === 'string' ? out : JSON.stringify(prune(out));
  if (text === undefined) text = 'ok';
  if (text.length > settings.maxOutputChars) {
    text = `${text.slice(0, settings.maxOutputChars)}\n…[truncated: ${text.length} chars total. Narrow the request (limit, before/after, filters).]`;
  }
  return { content: [{ type: 'text', text }] };
}

/** DISCORD_TOOLSETS=core expands to the everyday categories. */
export const CORE = ['messages', 'reactions', 'pins', 'polls', 'guilds', 'channels', 'threads', 'dms', 'friends', 'users', 'members', 'read_state',
  'notifications', 'presence', 'voice', 'live', 'interactions', 'invites', 'misc'];
const toolsets = new Set(settings.toolsets.flatMap((s) => (s === 'core' ? CORE : [s])));

export function enabled(t: ToolDef): boolean {
  if (settings.disabledTools.has(t.name)) return false;
  if (settings.readOnly && !t.readOnly) return false;
  if (toolsets.size && !toolsets.has(t.category) && t.category !== 'account') return false;
  return true;
}

export function registerAll(server: McpServer) {
  for (const t of tools) {
    if (!enabled(t)) continue;
    const schema = t.loose ? z.looseObject(t.shape) : z.object(t.shape);
    server.registerTool(t.name, {
      description: t.description,
      inputSchema: schema as any,
      annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: true },
    }, (async (args: any) => {
      try {
        return render(await t.handler(args ?? {}));
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
      }
    }) as any);
  }
}

export { z };
