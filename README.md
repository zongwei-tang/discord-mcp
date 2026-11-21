# discord-mcp

An MCP server that lets an AI assistant use Discord **as your own account**, the way you would in the app. It can also run with a bot token.

- **437 tools.** Messages, files, replies, forwards, polls, reactions, pins, search, threads, forums, DMs and group DMs, calls and voice, friends, profile, status and activity, notifications, unread state, server admin (channels, roles, permissions, members, moderation, AutoMod, audit log, emojis, stickers, soundboard, events, invites, webhooks, onboarding, templates, discovery), apps and slash commands, buttons, select menus and modals. The full list is in [TOOLS.md](TOOLS.md).
- **Personal accounts work.** Log in by scanning a QR code with the Discord phone app. No password is involved, and the token is stored locally in `~/.discord-mcp/account.json` with file mode 0600.
- **No Discord library.** The server calls the same HTTP API (v9) and gateway that the official web client uses, and sends the client's headers. Its only dependencies are the MCP SDK, `zod`, `ws` and `qrcode`.
- **Simple to extend.** Most tools are one-line route specs in `src/tools/catalog/endpoints.ts`. Every endpoint tool also accepts extra Discord API fields that aren't in its schema. `discord_api_request` can call any route.

> **Warning:** automating a user account ("self-bot") is against Discord's Terms of Service and can get the account banned. Use it at your own risk. Keep it on your own machine, and don't spam, mass-DM or mass-friend people. New accounts and unusual actions may be asked for a captcha. When that happens, the tool tells you to do that action once in the official app.

## Quick start

Requires Node.js 20 or newer.

```bash
git clone https://github.com/zongwei-tang/discord-mcp && cd discord-mcp
npm install && npm run build
node dist/index.js login        # shows a QR code: Discord phone app → Settings → Scan QR Code
```

Add it to your MCP client, for example Claude Code:

```bash
claude mcp add discord -- node /path/to/discord-mcp/dist/index.js
```

You can also skip the CLI login. Ask the assistant to "log in to Discord". It calls `discord_login`, which shows the QR code in the chat.

Other ways to log in:

- `node dist/index.js login --token <token>`
- Set `DISCORD_TOKEN` in the MCP config's `env`.
- For a bot, pass `--bot` with the `--token` login, or set `DISCORD_TOKEN_TYPE=bot`.

## Remote mode (Railway, claude.ai connectors, cloud sessions)

`node dist/index.js serve` runs a Streamable HTTP endpoint at `/mcp`. It reads `PORT` and `HOST`, and it refuses to start without `MCP_AUTH_TOKEN` (24+ characters). Generate a random one, for example with `openssl rand -hex 32`. Clients authenticate in one of two ways:

- `Authorization: Bearer <MCP_AUTH_TOKEN>` with `https://<app>/mcp`. Prefer this whenever the client supports headers.
- the token in the path, `https://<app>/mcp/<MCP_AUTH_TOKEN>`, for clients that only take a URL, such as claude.ai custom connectors

Treat that URL like a password: anyone who has it can use your Discord account. Your host's request logs (for example Railway's HTTP logs) record the full path, so anyone with access to those logs can see it. If it leaks, change `MCP_AUTH_TOKEN` and update your clients.

To deploy on Railway, point a service at this repo. The included `Dockerfile` and `railway.json` set up the build and a `/health` check. Then set `MCP_AUTH_TOKEN`, and attach a volume at `/data` so the login survives redeploys (`DISCORD_MCP_HOME=/data` is the image default). Then log the server in to your Discord account. QR login usually fails on cloud servers, because Discord asks for a captcha when a datacenter IP exchanges the login ticket. The reliable way:

1. On your own computer, run `node dist/index.js login` and scan the QR code. This works from a home connection.
2. Run `node dist/index.js token`, which prints the saved token.
3. On the server, set `DISCORD_TOKEN` to that value (for example as a Railway variable) and redeploy. Alternatively, call `discord_login_token` from any connected client.

A user token gives full access to your account, so keep it private. Using it from a cloud IP may also look more unusual to Discord than using it from home.

## What you can ask for

- "What's unread? Summarise my DMs." → `list_unread`, `read_messages`
- "Reply to Alice that I'll be late, and attach ~/notes.pdf." → `send_dm` with `files`
- "Find the message where someone posted the wifi password in the Study server." → `search_messages`
- "Run /imagine prompt:a red fox in the Midjourney channel and show me the result." → `run_slash_command`, `view_image`
- "Click the 'Accept' button on that bot message." → `click_button` (bots that answer with a form need `submit_modal` next)
- "Set me to Do Not Disturb with status 'exams' for 3 hours." → `set_status`, `set_custom_status`
- "Join the Gaming voice channel muted." → `join_voice_channel`. This is presence only: no audio is streamed.
- "Create a #announcements channel that only Mods can write in." → `create_guild_channel`, `set_channel_permission`
- "Time out the user spamming in #general for 10 minutes." → `timeout_member`

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN` | – | Use this token instead of the saved login |
| `DISCORD_TOKEN_TYPE` | `user` | `bot` for bot tokens (a `Bot ` prefix also works) |
| `DISCORD_GATEWAY` | `on` | `off` turns off the live connection. Status, voice, slash commands, events and unread counts need it. |
| `DISCORD_TOOLSETS` | all | Comma-separated categories to expose. `core` gives the 212 everyday tools; see TOOLS.md for category names. |
| `DISCORD_READ_ONLY` | – | `1` exposes only read-only tools |
| `DISCORD_DISABLED_TOOLS` | – | Comma-separated tool names to hide |
| `DISCORD_MCP_HOME` | `~/.discord-mcp` | Where the login, caches and downloads live |
| `DISCORD_LOCALE`, `DISCORD_TIMEZONE` | system | Sent as the client locale and timezone |

If your client struggles with 437 tools, use `DISCORD_TOOLSETS=core`. Claude Code loads MCP tools on demand, so it handles the full set.

## How it works

- `src/discord/rest.ts` is the HTTP client. It handles web-client headers, `X-Super-Properties` with the live build number, per-route rate limits with 429 retries, multipart uploads, data-URI conversion for images and sounds, and readable errors (including captcha and permission hints).
- `src/discord/gateway.ts` keeps the live connection open. It identifies like the web client, then caches the READY payload: servers, channels, DMs, roles, read states and voice states. It keeps a buffer of recent events and sends the presence, voice and member-request opcodes. It also computes your permissions so it can hide channels you can't see.
- `src/discord/remote-auth.ts` handles the QR login. It is Discord's "remote auth" handshake: an RSA-OAEP key exchange, nonce proof, ticket, then token exchange.
- `src/tools/catalog/endpoints.ts` (route specs) and `meta.ts` (descriptions and extra parameters) produce the 361 endpoint tools. `src/tools/custom/*` holds 76 hand-written tools, including chat reading and formatting, unread, slash commands, components and modals, presence and voice, live events, and moderation shortcuts.

Route and parameter research used the community [Discord Userdoccers](https://github.com/discord-userdoccers/discord-userdoccers) documentation. Other Discord MCP servers were reviewed for comparison: SaseQ/discord-mcp, cappyeo/discord-mcp, Microck/discord.py-self-mcp and olivier-motium/discord-user-mcp. This server is an independent implementation.

## Development

```bash
npm test                          # builds, then runs the offline end-to-end suite (fake Discord REST + gateway + QR login)
node dist/index.js tools          # list tools
node dist/index.js tools --markdown > TOOLS.md
```

## License

MIT
