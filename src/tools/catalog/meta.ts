/* Hand-written refinements for the endpoint catalogue: clearer descriptions, extra parameters, upload support. */
import type { Ep } from '../spec.js';

type Meta = Partial<Ep> & { bAdd?: Record<string, string>; qAdd?: Record<string, string> };

const CHANNEL_FIELDS: Record<string, string> = {
  name: 's', type: 'i|Change type (only text 0 <-> announcement 5)', position: 'i~', topic: 's~', nsfw: 'b~', rate_limit_per_user: 'i~', bitrate: 'i~',
  user_limit: 'i~', permission_overwrites: 'a~', parent_id: 'id~', rtc_region: 's~', video_quality_mode: 'i~', default_auto_archive_duration: 'i~',
  flags: 'i', available_tags: 'a', default_reaction_emoji: 'o~', default_thread_rate_limit_per_user: 'i', default_sort_order: 'i~', default_forum_layout: 'i',
  icon: 'data|Group DM icon: local file path, URL or data: URI', owner: 'id|Group DM: new owner user ID',
  archived: 'b|Thread: archived', auto_archive_duration: 'i|Thread: auto-archive minutes', locked: 'b|Thread: locked', invitable: 'b|Private thread: members can invite',
  applied_tags: 'ids|Forum post: tag IDs',
};

export const META: Record<string, Meta> = {
  // ---- messages
  get_message: { d: 'Get a single message by ID (raw Discord object). For readable history use read_messages.' },
  edit_message: { d: 'Edit one of your messages (content, flags, attachments to keep). Pass files to add new attachments.', files: true },
  delete_message: { d: 'Delete a message (yours, or anyone\'s with Manage Messages).', reason: true },
  bulk_delete_messages: { d: 'Bulk-delete 2-100 messages younger than 14 days (needs Manage Messages; bots only on most servers). For your own messages use purge_my_messages.', reason: true },
  crosspost_message: { d: 'Publish a message in an announcement channel to all following servers.' },
  start_typing: { d: 'Show "is typing…" in a channel for ~10 seconds.' },
  list_saved_messages: { d: 'List your saved ("bookmarked") messages.' },
  save_message: { d: 'Save (bookmark) a message for later.' },
  unsave_message: { d: 'Remove a message from your saved messages.' },
  // ---- reactions
  list_reactions: { d: 'List users who reacted to a message with an emoji.', q: { type: 'i|0 normal, 1 super reactions', after: 'id', limit: 'i|1-100' } },
  add_reaction: { d: 'React to a message with an emoji (unicode like 👍 or custom name:id).', qAdd: { type: 'i|0 normal, 1 super reaction (burst)' } },
  remove_own_reaction: { d: 'Remove your own reaction from a message.', pathDefaults: { reaction_type: '0' } },
  remove_user_reaction: { d: 'Remove another user\'s reaction (needs Manage Messages).', pathDefaults: { reaction_type: '0' } },
  remove_all_reactions_for_emoji: { d: 'Remove all reactions of one emoji from a message (needs Manage Messages).' },
  remove_all_reactions: { d: 'Remove every reaction from a message (needs Manage Messages).' },
  // ---- pins / polls
  list_message_pins: { d: 'List pinned messages in a channel (newest pins first).', q: { before: 'ts|Pins before this ISO time', limit: 'i|1-50' } },
  pin_message: { d: 'Pin a message in a channel.', reason: true },
  unpin_message: { d: 'Unpin a message.', reason: true },
  vote_in_poll: { d: 'Vote in a poll: answer_ids are the 1-based answer numbers. An empty list removes your vote.', b: { answer_ids: 'a!|Answer IDs, e.g. ["1"] (empty removes your vote)' } },
  end_poll: { d: 'End a poll early (only the poll creator).' },
  list_poll_answer_voters: { d: 'List users who voted for a poll answer.' },
  // ---- channels
  list_guild_channels: { d: 'List all channels of a server with full details (permission overwrites, topics…). For a compact tree use get_channel_tree.' },
  get_channel: { d: 'Get a channel, thread or DM by ID (raw object).' },
  create_guild_channel: {
    d: 'Create a channel in a server. type: 0 text, 2 voice, 4 category, 5 announcement, 13 stage, 15 forum, 16 media.', reason: true,
    bAdd: { type: 'i~|0 text, 2 voice, 4 category, 5 announcement, 13 stage, 15 forum, 16 media' },
  },
  modify_channel: { d: 'Edit a channel, thread or group DM: name, topic, slowmode, NSFW, category, permissions, bitrate, thread archive/lock, group DM icon…', b: CHANNEL_FIELDS, reason: true },
  delete_channel: { d: 'Delete a server channel / category, close a DM, leave a group DM, or delete a thread.', reason: true },
  modify_guild_channel_positions: {
    d: 'Reorder channels / move them between categories. positions: [{id, position?, parent_id?, lock_permissions?}].', b: {}, arrayBody: 'positions', reason: true,
  },
  modify_channel_permissions: {
    d: 'Set a permission overwrite on a channel for a role or member (type 0 = role, 1 = member). allow/deny accept names like ["SEND_MESSAGES"].',
    b: { type: 'i!|0 = role, 1 = member', allow: 's', deny: 's' }, reason: true,
  },
  delete_channel_permission: { d: 'Remove a role/member permission overwrite from a channel.', reason: true },
  follow_channel: { d: 'Follow an announcement channel into one of your server channels (needs Manage Webhooks there).' },
  set_voice_channel_status: { d: 'Set the status text shown under a voice channel.', b: { status: 's~|Status text (null clears)' } },
  // ---- threads / forums
  create_thread: {
    d: 'Create a thread in a text channel, or a post in a forum/media channel (pass message: {content} and optional files for forum posts). type: 11 public, 12 private.',
    files: true, bAdd: { message: 'o|Forum/media post first message: {content, sticker_ids?, ...}' },
  },
  create_thread_from_message: { d: 'Start a thread from an existing message.' },
  list_guild_active_threads: { d: 'List all active threads in a server that you can see.' },
  join_thread: { d: 'Join a thread.' },
  leave_thread: { d: 'Leave a thread.' },
  modify_thread_settings: { d: 'Change your notification settings for a thread.', b: { flags: 'i|Thread member flags (notifications: 2 all, 4 mentions only, 8 nothing)', muted: 'b', mute_config: 'o~' } },
  create_channel_tag: { d: 'Add a tag to a forum/media channel.' },
  modify_channel_tag: { d: 'Edit a forum tag.' },
  delete_channel_tag: { d: 'Delete a forum tag.' },
  // ---- DMs / calls
  get_dm_channel: { d: 'Get the existing DM channel with a user (if any).' },
  bulk_leave_group_dms: { d: 'Leave several group DMs at once.' },
  ring_channel_recipients: { d: 'Ring people in a DM/group DM call (start a call with join_voice_channel first). Empty recipients rings everyone.' },
  stop_ringing_channel_recipients: { d: 'Stop ringing people in a DM/group DM call (or decline an incoming call by passing your own ID).' },
  modify_call: { d: 'Change the voice region of a DM/group call.', b: { region: 's|Voice region id' } },
  add_channel_recipient: { d: 'Add a user (a friend) to a group DM.' },
  remove_channel_recipient: { d: 'Remove a user from a group DM you own.' },
  accept_message_request: { d: 'Accept a DM message request.', b: {}, fixed: { consent_status: 2 } },
  reject_message_request: { d: 'Reject (delete) a DM message request.' },
  batch_reject_message_requests: { d: 'Reject several DM message requests.' },
  get_message_request_details: { d: 'Get extra details (e.g. mutual servers) for pending message requests.' },
  // ---- servers
  get_guild: { d: 'Get a server\'s full settings object.', q: { with_counts: 'b' } },
  get_guild_preview: { d: 'Preview a server (name, counts, emojis, features) — works for discoverable servers you are not in.' },
  modify_guild: { d: 'Edit server settings: name, icon, banner, description, verification level, system/rules/AFK channels, ownership…', reason: true },
  delete_guild: { d: 'Permanently delete a server you own. Irreversible.', destructive: true },
  leave_guild: { d: 'Leave a server.', b: { lurking: 'b|true if you were only lurking' } },
  join_guild: { d: 'Join a discoverable server by ID (or lurk with lurker=true).', q: { lurker: 'b', session_id: 's', location: 's' } },
  get_audit_log: { d: 'Read the server audit log (needs View Audit Log). Filter by user_id, action_type, before/after.' },
  // ---- members
  list_guild_members: { d: 'List server members (bots; user accounts usually need Manage Server). For search use search_members.' },
  query_guild_members: { d: 'Search server members whose username/nickname starts with a query (REST; bots). User accounts: use search_members.' },
  search_guild_members: { d: 'Advanced member search (Manage Server/moderators): filters by roles, join date, join source, safety signals.' },
  get_guild_member: { d: 'Get one member of a server (roles, nickname, join date, timeout).' },
  get_current_guild_member: { d: 'Get your own member object in a server.' },
  modify_guild_member: { d: 'Edit a member: nickname, roles, server mute/deafen, move/disconnect voice (channel_id), timeout (communication_disabled_until).', reason: true },
  modify_current_guild_member: { d: 'Change your own server nickname / server avatar / banner / bio.', b: { nick: 's~', avatar: 'data~', banner: 'data~', bio: 's~', pronouns: 's~' }, reason: true },
  modify_guild_member_profile: { d: 'Edit your per-server profile (server avatar, banner, bio, pronouns).', b: { avatar: 'data~', banner: 'data~', bio: 's~', pronouns: 's~', nick: 's~' } },
  add_guild_member: { d: 'Add a user to a server with an OAuth2 access token (bot apps only).' },
  kick_member: { d: 'Kick a member from a server.', reason: true },
  add_member_role: { d: 'Give a role to a member.', reason: true },
  remove_member_role: { d: 'Take a role away from a member.', reason: true },
  list_members_with_unusual_dm_activity: { d: 'List members flagged for unusual DM activity (moderators).' },
  // ---- moderation
  ban_member: { d: 'Ban a user from a server, optionally deleting their recent messages.', reason: true },
  unban_member: { d: 'Unban a user.', reason: true },
  bulk_ban_members: { d: 'Ban up to 200 users at once.', reason: true },
  list_guild_bans: { d: 'List banned users.' },
  search_guild_bans: { d: 'Search the ban list by username.' },
  get_guild_ban: { d: 'Check whether a user is banned (and why).' },
  get_guild_prune: { d: 'Count members a prune would remove (inactive for N days).' },
  prune_guild: { d: 'Kick members inactive for N days (optionally only those with given roles).', reason: true },
  // ---- roles
  list_guild_roles: { d: 'List all roles in a server (with permissions).' },
  create_guild_role: { d: 'Create a role. permissions accept names like ["MANAGE_MESSAGES"].', reason: true, bAdd: { permissions: 's', colors: 'o' } },
  modify_guild_role: { d: 'Edit a role: name, colour, permissions, hoist, mentionable, icon.', reason: true, bAdd: { permissions: 's~', colors: 'o~' } },
  delete_guild_role: { d: 'Delete a role.', reason: true },
  modify_guild_role_positions: { d: 'Reorder roles. positions: [{id, position}].', b: {}, arrayBody: 'positions', reason: true },
  get_guild_role_member_counts: { d: 'Member count of every role.' },
  list_guild_role_members: { d: 'List member IDs that have a role (up to 100).' },
  add_guild_role_members: { d: 'Give a role to several members at once (max 30).' },
  // ---- invites
  get_invite: { d: 'Look up an invite (server, channel, inviter, counts) without joining.', q: { with_counts: 'b', with_expiration: 'b', guild_scheduled_event_id: 'id' } },
  accept_invite: { d: 'Join a server or group DM with an invite code/link. May require a captcha on new accounts.', b: { session_id: 's' } },
  delete_invite: { d: 'Revoke an invite.', reason: true },
  list_guild_invites: { d: 'List all invites of a server (needs Manage Server).' },
  list_channel_invites: { d: 'List invites to a channel.' },
  create_channel_invite: { d: 'Create an invite link for a channel. Returns the code (https://discord.gg/<code>).', reason: true },
  list_user_invites: { d: 'List your friend invites.' },
  create_user_invite: { d: 'Create a friend invite link (anyone using it becomes your friend).' },
  revoke_user_invites: { d: 'Revoke all your friend invites.' },
  // ---- emojis / stickers / sounds
  list_guild_emojis: { d: 'List a server\'s custom emojis.' },
  create_guild_emoji: { d: 'Upload a custom emoji (image ≤256KB: path, URL or data URI).', reason: true },
  modify_guild_emoji: { d: 'Rename an emoji or change which roles can use it.', reason: true },
  delete_guild_emoji: { d: 'Delete a custom emoji.', reason: true },
  get_emoji_source: { d: 'Find which server a custom emoji is from (and whether you can join it).' },
  create_guild_sticker: {
    d: 'Upload a sticker (PNG/APNG/GIF/Lottie ≤512KB). Give the image as files: [{path|url}] (first file is used).',
    b: { name: 's!', description: 's', tags: 's!|Related emoji name, e.g. "smile"' }, files: true, fileField: 'file', formFields: true, reason: true,
  },
  modify_guild_sticker: { d: 'Edit a sticker\'s name, description or tags.', reason: true },
  delete_guild_sticker: { d: 'Delete a sticker.', reason: true },
  create_guild_soundboard_sound: { d: 'Upload a soundboard sound (mp3/ogg ≤512KB).', bAdd: { sound: 'data!' }, reason: true },
  modify_guild_soundboard_sound: { d: 'Edit a soundboard sound.', reason: true },
  delete_guild_soundboard_sound: { d: 'Delete a soundboard sound.', reason: true },
  send_soundboard_sound: { d: 'Play a soundboard sound in the voice channel you are connected to (join_voice_channel first).' },
  // ---- events
  create_guild_scheduled_event: { d: 'Create a scheduled event (stage, voice or external). For external events set entity_metadata {location} and scheduled_end_time.', reason: true },
  modify_guild_scheduled_event: { d: 'Edit or start/end/cancel an event (status: 2 active, 3 completed, 4 cancelled).', reason: true, bAdd: { status: 'i|2 active, 3 completed, 4 cancelled' } },
  delete_guild_scheduled_event: { d: 'Delete a scheduled event.', reason: true },
  list_user_guild_scheduled_events: { d: 'List events you marked as interested in, across servers.' },
  mark_interested_in_event: { d: 'Mark yourself as interested in an event.' },
  unmark_interested_in_event: { d: 'Remove your interest in an event.' },
  // ---- webhooks
  create_webhook: { d: 'Create a webhook in a channel (returns its URL token).', reason: true },
  execute_webhook: {
    d: 'Post a message through a webhook (custom username/avatar, embeds and components allowed).', files: true,
    q: { wait: 'b|Return the created message', thread_id: 'id|Post into this thread' },
    bAdd: { username: 's', avatar_url: 's', thread_name: 's|Create a forum post with this title' },
  },
  edit_webhook_message: { files: true },
  // ---- voice / stage
  modify_current_user_voice_state: { d: 'Your voice state in a stage channel: request to speak, or become speaker/audience.', b: { channel_id: 'id', suppress: 'b', request_to_speak_timestamp: 'ts~' } },
  modify_user_voice_state: { d: 'Invite a user to speak (suppress=false) or move them to the audience in a stage channel.', b: { channel_id: 'id!', suppress: 'b' } },
  send_voice_channel_effect: { d: 'Send an emoji effect in the voice channel you are in.', b: { emoji_id: 'id~', emoji_name: 's~', animation_type: 'i~|0 premium, 1 basic' } },
  create_stage_instance: { d: 'Start a stage (go live) in a stage channel with a topic.', reason: true },
  modify_stage_instance: { d: 'Change a live stage\'s topic.', reason: true },
  delete_stage_instance: { d: 'End a live stage.', reason: true },
  // ---- users / profile
  get_current_user: { d: 'Get your own account (username, email, phone, MFA, Nitro…).' },
  modify_current_user: { d: 'Edit your account: username (needs password), display name (global_name), avatar, banner, bio, accent colour…' },
  modify_current_user_account: { d: 'Edit account-level fields (global_name, avatar, bio…).' },
  get_user: { d: 'Get a user\'s basic public info.' },
  get_user_profile: {
    d: 'Get a user\'s full profile: bio, pronouns, badges, connected accounts, mutual servers and friends.',
    q: { with_mutual_guilds: 'b', with_mutual_friends: 'b', with_mutual_friends_count: 'b', guild_id: 'id|Include this server\'s member profile' },
  },
  modify_user_profile: { d: 'Edit your profile: bio, pronouns, banner, accent colour, profile theme colours.' },
  list_mutual_relationships: { d: 'List friends you have in common with a user.' },
  list_mentions: { d: 'Your recent mentions inbox (pings across servers).', q: { limit: 'i|1-100', before: 'id', guild_id: 'id', roles: 'b|Include role mentions', everyone: 'b|Include @everyone' } },
  dismiss_mention: { d: 'Remove a message from your mentions inbox.' },
  get_user_notes: { d: 'All your private notes on users.' },
  get_user_note: { d: 'Your private note on a user.' },
  set_user_note: { d: 'Set your private note on a user (only you can see it).', b: { note: 's~!' } },
  list_user_affinities_v2: { d: 'Users you interact with most.' },
  list_guild_affinities: { d: 'Servers you interact with most.' },
  list_channel_affinities: { d: 'Channels you interact with most.' },
  join_hypesquad_house: { d: 'Join a HypeSquad house: 1 Bravery, 2 Brilliance, 3 Balance.' },
  leave_hypesquad_house: { d: 'Leave your HypeSquad house.' },
  // ---- friends
  list_relationships: { d: 'List all relationships raw (type 1 friend, 2 blocked, 3 incoming request, 4 outgoing request). For a readable list use list_friends.' },
  send_friend_request: { d: 'Send a friend request by username (new usernames: discriminator "0" or omit).' },
  set_friend_nickname: { d: 'Set a private nickname for a friend.', b: { nickname: 's~' } },
  remove_relationship: { d: 'Remove a friend, cancel/decline a friend request, or unblock a user.' },
  ignore_user: { d: 'Ignore a user (hide their messages without blocking).' },
  unignore_user: { d: 'Stop ignoring a user.' },
  bulk_remove_relationships: { d: 'Remove many relationships at once (e.g. clear all incoming requests).', q: { relationship_type: 'i|3 incoming requests, 4 outgoing', only_likely_spammers: 'b' } },
  list_friend_suggestions: { d: 'Friend suggestions.' },
  // ---- settings / notifications
  get_user_settings: { d: 'Your client settings (status, theme, locale, guild folders, privacy…).' },
  modify_user_settings: { d: 'Change client settings: status, custom_status, theme, locale, developer_mode, guild_folders, friend_source_flags, DM privacy (default_guilds_restricted)…' },
  modify_user_guild_settings: {
    d: 'Notification settings for a server (use guild_id "@me" for DMs): mute, suppress @everyone/roles, message_notifications, channel_overrides.',
    b: {
      muted: 'b', mute_config: 'o~|{end_time: ISO8601|null, selected_time_window: seconds|-1}', message_notifications: 'i|0 all, 1 mentions only, 2 nothing, 3 inherit',
      suppress_everyone: 'b', suppress_roles: 'b', mobile_push: 'b', hide_muted_channels: 'b', mute_scheduled_events: 'b', notify_highlights: 'i|0 default, 1 disabled, 2 enabled',
      channel_overrides: 'o|Map of channel_id -> {muted, mute_config, message_notifications, collapsed}', flags: 'i',
    },
  },
  bulk_modify_user_guild_settings: { d: 'Change notification settings for several servers at once.' },
  modify_notification_settings: { d: 'Desktop/mobile notification flags.' },
  list_notification_center_items: { d: 'Notification center (activity inbox: friend requests, reminders…).' },
  // ---- read states
  acknowledge_message: { d: 'Mark a channel as read up to a message. (mark_read does this for you.)', b: { token: 's~', manual: 'b', mention_count: 'i', last_viewed: 'i' } },
  acknowledge_pinned_messages: { d: 'Mark a channel\'s pins as seen.' },
  bulk_update_read_states: { d: 'Mark many channels read: read_states [{channel_id, message_id}].' },
  delete_read_state: { d: 'Mark a channel as unread (delete its read state).' },
  // ---- apps / commands
  list_authorized_apps: { d: 'Apps you have authorized with your account (Settings → Authorized Apps).' },
  deauthorize_app: { d: 'Revoke an app\'s access to your account.' },
  preview_app_authorization: {
    d: 'Preview an OAuth2 authorization (e.g. adding a bot to a server): shows the app, scopes and servers you can add it to.',
    q: { client_id: 'id!', scope: 's!|Space-separated scopes, e.g. "bot applications.commands"', response_type: 's', redirect_uri: 's', state: 's', permissions: 's', integration_type: 'i|0 server install, 1 user install' },
  },
  authorize_app: {
    d: 'Authorize an app — e.g. add a bot to a server (scope "bot applications.commands", guild_id, permissions) or install a user app (integration_type 1).',
    q: { client_id: 'id!', scope: 's!|Space-separated scopes', response_type: 's', redirect_uri: 's', state: 's', integration_type: 'i' },
    bAdd: { authorize: 'b', guild_id: 'id', permissions: 's', integration_type: 'i' }, fixed: { authorize: true },
  },
  list_applications: { d: 'Apps you own in the developer portal.', q: { with_team_applications: 'b' } },
  list_guild_applications: { d: 'Bots/apps installed in a server.', q: { include_team: 'b', type: 'i', channel_id: 'id' } },
  launch_embedded_activity: { d: 'Launch an Activity (game/app) in a voice channel you are in.' },
  bulk_modify_global_application_commands: { d: 'Overwrite all global commands of an app you own.', b: {}, arrayBody: 'commands' },
  bulk_modify_guild_application_commands: { d: 'Overwrite all guild commands of an app you own.', b: {}, arrayBody: 'commands' },
  get_guild_command_index: { d: 'All slash/context commands available in a server (with application info). run_slash_command uses this for you.' },
  get_channel_command_index: { d: 'All commands usable in a channel or DM.' },
  get_user_command_index: { d: 'Commands of user-installed apps.' },
  list_login_sessions: { d: 'Devices logged into your account (Settings → Devices).' },
  logout_login_sessions: { d: 'Log out other devices by session hash (session_id_hashes from list_login_sessions).' },
  get_account_standing: { d: 'Your account standing / safety hub status (warnings, violations).' },
  set_headless_activity: { d: 'Show a "playing" activity without the gateway (headless session). Returns a token to delete it later.', b: { activities: 'a!|[{name, type: 0, application_id?, state?, details?}]', token: 's' } },
  // ---- discovery / templates / misc
  search_discoverable_guilds: { d: 'Search public servers in Server Discovery.', q: { query: 's!', limit: 'i', offset: 'i', categories: 'is' } },
  list_discoverable_guilds: { d: 'Browse featured public servers.' },
  get_guild_template: { d: 'Look up a server template by code.' },
  use_guild_template: { d: 'Create a new server from a template.' },
  search_gifs: { d: 'Search GIFs (Tenor/Giphy) like the GIF picker. Send the returned url as message content.', q: { q: 's!|Search text', media_format: 's|mp4 or gif', provider: 's|tenor', locale: 's', limit: 'i' } },
  list_trending_gifs: { q: { media_format: 's', provider: 's', locale: 's', limit: 'i' } },
  list_trending_gif_categories: { q: { media_format: 's', provider: 's', locale: 's' } },
  list_voice_regions: { d: 'Voice regions available for calls/channels.' },
};

export function applyMeta(eps: Ep[]): Ep[] {
  return eps.map((ep) => {
    const m = META[ep.n];
    let out: Ep = { ...ep };
    if (m) {
      const { bAdd, qAdd, ...rest } = m;
      out = { ...out, ...rest };
      if (bAdd) out.b = { ...(out.b || {}), ...bAdd };
      if (qAdd) out.q = { ...(out.q || {}), ...qAdd };
    }
    const [method, path] = out.r.split(' ');
    if (!m?.d) out.d = `${ep.d}.`;
    out.d = `${out.d} [${method} ${path}]`;
    if (out.reason === undefined && method !== 'GET' && /^\/(guilds|webhooks|stage-instances)\//.test(path) && !/members\/@me|requests\/@me|scheduled-events\/\{event_id\}(\/\{exception_id\})?\/users|onboarding-responses|\/ack/.test(path)) out.reason = true;
    return out;
  });
}
