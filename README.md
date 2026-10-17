# Common Room

A no-login, Discord-style place for a game dev crew.

- Accounts without email: permanent username + changeable display name, profile (picture, status, about me) and a recovery code
- Servers: the public lobby plus private invite-only servers (invite links with expiry / max uses, roles: owner / admin / mod / member)
- Chat with channels, attachments, @mentions and pings, direct messages (block, DMs-off, report)
- Moderation: delete, mute, kick, ban; reports with evidence snapshots; site-admin panel (ADMIN_KEY), audit log, review of reported servers
- Games: Tic-Tac-Toe, Connect 4, Rock Paper Scissors, Hand Cricket, Hand Football
- Voice (peer to peer), live co-edited workspace files with cursors, tasks and bugs board, playable web-export builds
- Mobile-first layout with a bottom tab bar (Chats, Servers, DMs, You); the desktop layout shows everything side by side

All files live in the repo root.

## Environment variables
- `MONGODB_URI` (and optional `MONGODB_DB`): store everything in MongoDB (uploads in GridFS). Without it, one JSON file on local disk (`DATA_DIR`).
- `ADMIN_KEY`: secret that makes you the site admin. Register a reserved name (like `rudra`) with it, or unlock it on the You tab.
- `RESERVED_NAMES`: comma separated usernames nobody else can take.
- `MAX_BUILD_MB` (default 100), `BUILD_SANDBOX=0` (trusted builds only).

## Run
`npm install && npm start`, open http://localhost:3000
