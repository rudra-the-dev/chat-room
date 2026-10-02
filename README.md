# Common Room

No-login Discord-style room for a game dev crew. One person per IP (anti-bot).

- Chat: #general #games #random #dev, file attachments (10 MB), role tags (Dev / Modeler / Tester / Other)
- Games (in #games): Tic-Tac-Toe, Connect 4, Rock Paper Scissors
- Voice: join from the sidebar (WebRTC, peer to peer; needs HTTPS or localhost + mic permission)
- Workspace: shared project files edited live by everyone at once (CRDT, see crdt.js), saved versions + restore, "who's editing" markers;
  upload models, textures and scripts (versioned); tasks & bug board for testers and devs

All files live in the repo root. Run: `npm install && npm start`, open http://localhost:3000
Render: build `npm install`, start `node server.js`. Free plan wipes data on restart; add a disk and set DATA_DIR to keep it.
