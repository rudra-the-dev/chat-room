const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');
const Doc = require('./crdt.js');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'messages.json');
const WS_FILE = path.join(DATA_DIR, 'workspace.json');
const MAX_FILE_MB = 10, MAX_MESSAGES = 300, MAX_FILES = 100;
const CHANNELS = ['general', 'games', 'random', 'dev'];
const ROLES = ['Dev', 'Modeler', 'Tester', 'Other'];
const TEXT_EXT = /\.(txt|md|json|js|ts|py|gd|cs|cpp|h|lua|glsl|gdshader|tscn|tres|cfg|ini|ya?ml|xml|html|css|csv)$/i;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const saver = (file, get) => { let t; return () => { clearTimeout(t); t = setTimeout(() => fs.writeFile(file, JSON.stringify(get()), () => {}), 300); }; };

let db = load(DB_FILE, {});
if (Array.isArray(db)) db = { general: db };
CHANNELS.forEach((c) => { db[c] = db[c] || []; });
let ws = load(WS_FILE, { files: {}, tasks: [] });
const save = saver(DB_FILE, () => db);
const saveWs = saver(WS_FILE, () => ws);

const SAFE_INLINE = { image: /\.(png|jpe?g|gif|webp)$/i, video: /\.(mp4|webm)$/i, audio: /\.(mp3|ogg|wav|m4a)$/i };
const kindOf = (f) => Object.keys(SAFE_INLINE).find((k) => SAFE_INLINE[k].test(f)) || 'file';
const unlinkUrl = (u) => fs.unlink(path.join(UPLOAD_DIR, path.basename(u)), () => {});

function ipOf(headers, fallback) {
  return headers['cf-connecting-ip'] || (headers['x-forwarded-for'] || '').split(',')[0].trim() || fallback || 'unknown';
}
const cleanName = (n) => String(n || '').trim().slice(0, 24) || 'Guest';
const validName = (n) => typeof n === 'string' && /^[\w\-. \/]{1,60}$/.test(n) && !n.includes('..') && !n.startsWith('/');

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    },
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 100e6 });
app.set('trust proxy', 1);

// Everything lives in the root folder, so only serve these files (never server.js / data).
app.get(['/', '/index.html'], (q, r) => r.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.js', (q, r) => r.sendFile(path.join(__dirname, 'app.js')));
app.get('/crdt.js', (q, r) => r.sendFile(path.join(__dirname, 'crdt.js')));
app.get('/style.css', (q, r) => r.sendFile(path.join(__dirname, 'style.css')));
app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (kindOf(filePath) === 'file') res.setHeader('Content-Disposition', 'attachment');
  },
}));
app.get('/api/messages', (req, res) => res.json(db[req.query.ch] || []));

const lastPost = new Map();
setInterval(() => lastPost.clear(), 60000);

// Shared guard for both upload routes: rate limit, parse, and require a live socket from the same IP.
function guarded(handler) {
  return (req, res) => {
    const now = Date.now();
    const ip = ipOf(req.headers, req.ip);
    if (now - (lastPost.get(ip) || 0) < 800) return res.status(429).json({ error: 'Slow down a little.' });
    lastPost.set(ip, now);
    upload.single('file')(req, res, (err) => {
      const drop = () => req.file && fs.unlink(req.file.path, () => {});
      try {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Files can be up to ${MAX_FILE_MB} MB.` : 'Upload failed.' });
        const s = io.sockets.sockets.get(String(req.body.sid || ''));
        if (!s || s.data.ip !== ip) { drop(); return res.status(403).json({ error: 'Not connected.' }); }
        handler(req, res, s, now, drop);
      } catch (e) { drop(); res.status(500).json({ error: 'Server error.' }); }
    });
  };
}

app.post('/api/post', guarded((req, res, s, now, drop) => {
  const ch = String(req.body.ch);
  if (!CHANNELS.includes(ch)) { drop(); return res.status(400).json({ error: 'Unknown channel.' }); }
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text && !req.file) return res.status(400).json({ error: 'Write a message or attach a file.' });
  const msg = { id: crypto.randomUUID(), ch, name: s.data.name, role: s.data.role, text, time: now };
  if (req.file) msg.file = { url: '/uploads/' + req.file.filename, name: req.file.originalname.slice(0, 120), size: req.file.size, kind: kindOf(req.file.filename) };
  db[ch].push(msg);
  while (db[ch].length > MAX_MESSAGES) {
    const old = db[ch].shift();
    if (old.file) unlinkUrl(old.file.url);
  }
  save();
  io.emit('message', msg);
  res.json({ ok: true });
}));

// ---------- workspace (shared project files + tasks) ----------
const editing = () => {
  const m = {};
  for (const s of io.sockets.sockets.values()) if (s.data.editing) (m[s.data.editing] = m[s.data.editing] || []).push(s.data.name);
  return m;
};
const pushFiles = () => {
  const ed = editing();
  io.emit('ws:files', Object.values(ws.files).map((f) => ({ name: f.name, kind: f.kind, v: f.v, by: f.by, role: f.role, time: f.time, size: f.size, editing: ed[f.name] || [] })));
};
const pushTasks = () => io.emit('tasks', ws.tasks);

// ---- live docs: text files are shared CRDT docs while someone has them open ----
const docs = new Map(); // name -> { doc, timer }
const roomOf = (n) => 'doc:' + n;
function getDoc(name) {
  let d = docs.get(name);
  if (!d) { d = { doc: Doc.fromText(ws.files[name].content || ''), timer: null }; docs.set(name, d); }
  return d;
}
function flush(name) {
  const d = docs.get(name), f = ws.files[name];
  if (d) clearTimeout(d.timer);
  if (d && f && f.kind === 'text') { f.content = d.doc.text(); f.size = f.content.length; saveWs(); }
}
function resetDoc(name) { docs.delete(name); io.to(roomOf(name)).emit('doc:reset', name); }
function leaveDoc(s) {
  const name = s.data.editing;
  if (!name) return;
  s.data.editing = null;
  s.to(roomOf(name)).emit('doc:gone', s.id);
  s.data.cur = null;
  s.leave(roomOf(name));
  const r = io.sockets.adapter.rooms.get(roomOf(name));
  if (!r || !r.size) { flush(name); docs.delete(name); }
}

function commit(s, name, data, note, live) {
  let f = ws.files[name];
  if (!f) f = ws.files[name] = { name, v: 0, history: [] };
  const e = { v: ++f.v, by: s.data.name, role: s.data.role, time: Date.now(), note: String(note || '').slice(0, 100), content: data.content, url: data.url, size: data.size };
  f.history.push(e);
  while (f.history.length > 15) {
    const o = f.history.shift();
    if (o.url && o.url !== data.url && !f.history.some((h) => h.url === o.url)) unlinkUrl(o.url);
  }
  Object.assign(f, { kind: data.url ? 'bin' : 'text', by: e.by, role: e.role, time: e.time, content: data.content, url: data.url, size: data.size != null ? data.size : (data.content || '').length });
  if (!live && docs.has(name)) resetDoc(name);
  saveWs(); pushFiles();
  io.emit('ws:updated', { name, v: f.v, by: e.by });
  return f.v;
}

app.post('/api/asset', guarded((req, res, s, now, drop) => {
  if (!req.file) return res.status(400).json({ error: 'No file.' });
  const name = validName(req.body.name) ? req.body.name : req.file.originalname.replace(/[^\w\-. ]/g, '_').slice(0, 60);
  if (!ws.files[name] && Object.keys(ws.files).length >= MAX_FILES) { drop(); return res.status(400).json({ error: 'Workspace is full.' }); }
  if (TEXT_EXT.test(name)) {
    const content = fs.readFileSync(req.file.path, 'utf8');
    drop();
    commit(s, name, { content }, req.body.note);
  } else {
    commit(s, name, { url: '/uploads/' + req.file.filename, size: req.file.size }, req.body.note);
  }
  res.json({ ok: true });
}));

// ---------- one person per IP ----------
const ipSocket = new Map();
io.use((s, next) => {
  const ip = ipOf(s.handshake.headers, s.handshake.address);
  const tok = String((s.handshake.auth && s.handshake.auth.tok) || '').slice(0, 32);
  const cur = ipSocket.get(ip);
  if (cur) {
    const old = io.sockets.sockets.get(cur.id);
    if (old && !(tok && tok === cur.tok)) return next(new Error('ip-busy'));  // a different browser holds this IP
    if (old) old.disconnect(true);                                           // same browser (refresh / 2nd tab): replace the old connection
  }
  s.data.ip = ip; s.data.name = 'Guest'; s.data.role = 'Other';
  ipSocket.set(ip, { id: s.id, tok });
  next();
});

// ---------- games ----------
const games = new Map();
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const ROLES_OF = { ttt: ['X', 'O'], c4: ['R', 'Y'] };
function c4win(b, p) {
  for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
    let k = 0;
    for (; k < 4; k++) { const rr = r + dr * k, cc = c + dc * k; if (rr < 0 || rr > 5 || cc < 0 || cc > 6 || b[rr * 7 + cc] !== p) break; }
    if (k === 4) return true;
  }
  return false;
}
const pub = (g) => ({
  id: g.id, type: g.type, status: g.status, winner: g.winner,
  host: g.host.name, hostSid: g.host.sid, guest: g.guest && g.guest.name, guestSid: g.guest && g.guest.sid,
  board: g.board, turn: g.turn, picked: Object.keys(g.picks), shown: g.shown,
});
const pushGames = () => io.emit('games', [...games.values()].map(pub));
const reset = (g) => {
  g.board = Array(g.type === 'c4' ? 42 : 9).fill('');
  g.turn = g.type === 'c4' ? 'R' : 'X';
  g.picks = {}; g.shown = null; g.winner = null; g.status = g.guest ? 'playing' : 'waiting';
};
const leaveGames = (sid) => { for (const [id, g] of games) if (g.host.sid === sid || (g.guest && g.guest.sid === sid)) games.delete(id); };
const inGame = (sid) => [...games.values()].some((g) => g.host.sid === sid || (g.guest && g.guest.sid === sid));

// ---------- voice ----------
const voiceList = () => [...io.sockets.sockets.values()].filter((x) => x.data.voice).map((x) => ({ id: x.id, name: x.data.name }));
const pushVoice = () => io.emit('voice:list', voiceList());
const done = (cb, o) => typeof cb === 'function' && cb(o);

io.on('connection', (s) => {
  const on = (ev, fn) => s.on(ev, (...a) => { try { fn(...a); } catch (e) { console.error(ev, e.message); } });
  io.emit('online', ipSocket.size);
  s.emit('games', [...games.values()].map(pub));
  s.emit('tasks', ws.tasks);
  s.emit('voice:list', voiceList());
  pushFiles();

  on('hello', (p) => {
    p = p || {};
    s.data.name = cleanName(p.name);
    s.data.role = ROLES.includes(p.role) ? p.role : 'Other';
    if (s.data.voice) pushVoice();
  });

  // games
  on('game:create', (type) => {
    if (!ROLES_OF[type] && type !== 'rps') return;
    if (inGame(s.id)) return;
    const g = { id: crypto.randomBytes(4).toString('hex'), type, host: { sid: s.id, name: s.data.name }, guest: null };
    reset(g); games.set(g.id, g); pushGames();
  });
  on('game:join', (id) => {
    const g = games.get(id);
    if (!g || g.guest || inGame(s.id)) return;
    g.guest = { sid: s.id, name: s.data.name }; g.status = 'playing'; pushGames();
  });
  on('game:move', (p) => {
    const { id, v } = p;
    const g = games.get(id);
    if (!g || g.status !== 'playing') return;
    const isHost = g.host.sid === s.id;
    if (!isHost && !(g.guest && g.guest.sid === s.id)) return;
    if (g.type === 'rps') {
      if (!BEATS[v] || g.picks[s.id]) return;
      g.picks[s.id] = v;
      const a = g.picks[g.host.sid], b = g.picks[g.guest.sid];
      if (a && b) {
        g.shown = { host: a, guest: b };
        g.winner = a === b ? 'draw' : BEATS[a] === b ? g.host.sid : g.guest.sid;
        g.status = 'done';
      }
    } else {
      const [r0, r1] = ROLES_OF[g.type];
      const role = isHost ? r0 : r1;
      if (g.turn !== role || !Number.isInteger(v)) return;
      let won;
      if (g.type === 'ttt') {
        if (v < 0 || v > 8 || g.board[v]) return;
        g.board[v] = role;
        won = LINES.some((l) => l.every((i) => g.board[i] === role));
      } else {
        if (v < 0 || v > 6) return;
        let i = -1;
        for (let r = 5; r >= 0; r--) if (!g.board[r * 7 + v]) { i = r * 7 + v; break; }
        if (i < 0) return;
        g.board[i] = role;
        won = c4win(g.board, role);
      }
      if (won) { g.winner = role; g.status = 'done'; }
      else if (g.board.every(Boolean)) { g.winner = 'draw'; g.status = 'done'; }
      else g.turn = role === r0 ? r1 : r0;
    }
    pushGames();
  });
  on('game:rematch', (id) => {
    const g = games.get(id);
    if (g && g.status === 'done' && (g.host.sid === s.id || g.guest.sid === s.id)) { reset(g); pushGames(); }
  });
  on('game:leave', () => { leaveGames(s.id); pushGames(); });

  // voice (WebRTC signaling only; audio goes peer to peer)
  on('voice:join', (cb) => {
    s.data.voice = true;
    done(cb, voiceList().filter((x) => x.id !== s.id));
    pushVoice();
  });
  on('voice:leave', () => { s.data.voice = false; pushVoice(); });
  on('voice:signal', (p) => {
    const t = io.sockets.sockets.get(p.to);
    if (t && t.data.voice && s.data.voice) t.emit('voice:signal', { from: s.id, data: p.data });
  });

  // workspace files (text files are live CRDT docs)
  const hist = (f) => f.history.map(({ v, by, role, time, note }) => ({ v, by, role, time, note })).reverse();
  on('ws:open', (name, cb) => {
    const f = ws.files[name];
    if (!f) return done(cb, { error: 'missing' });
    leaveDoc(s);
    const res = { kind: f.kind, v: f.v, url: f.url, size: f.size, history: hist(f) };
    if (f.kind === 'text') { s.data.editing = name; s.join(roomOf(name)); res.runs = getDoc(name).doc.dump();
      res.cursors = [];
      for (const id of io.sockets.adapter.rooms.get(roomOf(name)) || []) {
        const o = io.sockets.sockets.get(id);
        if (o && o !== s && o.data.cur) res.cursors.push({ id, user: o.data.name, a: o.data.cur.a, b: o.data.cur.b });
      }
    }
    pushFiles();
    done(cb, res);
  });
  on('ws:close', () => { leaveDoc(s); pushFiles(); });
  on('ws:hist', (name, cb) => { const f = ws.files[name]; if (f) done(cb, { v: f.v, history: hist(f) }); });
  on('ws:create', (name, cb) => {
    if (!validName(name) || ws.files[name] || Object.keys(ws.files).length >= MAX_FILES) return done(cb, { error: 'Bad name, duplicate, or workspace full.' });
    commit(s, name, { content: '' }, 'created');
    done(cb, { ok: true });
  });
  on('doc:ops', (p) => {
    if (p.name !== s.data.editing || !Array.isArray(p.ops) || p.ops.length > 100000) return;
    const d = getDoc(p.name), applied = [];
    for (const op of p.ops) if (d.doc.apply(op)) applied.push(op);
    if (!applied.length) return;
    s.to(roomOf(p.name)).emit('doc:ops', { name: p.name, ops: applied });
    clearTimeout(d.timer);
    d.timer = setTimeout(() => flush(p.name), 1500);
  });
  on('doc:cursor', (p) => {
    const ok = (k) => typeof k === 'string' && (k === '' || /^\d{1,9}\.[a-z0-9]{1,8}$/.test(k));
    if (p.name !== s.data.editing || !ok(p.a) || !ok(p.b)) return;
    s.data.cur = { a: p.a, b: p.b };
    s.to(roomOf(p.name)).emit('doc:cursor', { id: s.id, user: s.data.name, a: p.a, b: p.b });
  });
  on('ws:save', (p, cb) => { // "save version" snapshot of the live doc
    const f = ws.files[p.name];
    if (!f || f.kind !== 'text') return done(cb, { error: 'Cannot save.' });
    const d = docs.get(p.name);
    const content = d ? d.doc.text() : f.content;
    done(cb, { ok: true, v: commit(s, p.name, { content }, p.note, true) });
  });
  on('ws:restore', (p, cb) => {
    const f = ws.files[p.name];
    const h = f && f.history.find((x) => x.v === p.v);
    if (!h || h.content === undefined) return done(cb, { error: 'Cannot restore that version.' });
    done(cb, { ok: true, v: commit(s, p.name, { content: h.content }, 'restored v' + p.v) });
  });
  on('ws:delete', (name) => {
    const f = ws.files[name];
    if (!f) return;
    f.history.forEach((h) => h.url && unlinkUrl(h.url));
    io.to(roomOf(name)).emit('doc:reset', name);
    docs.delete(name);
    delete ws.files[name]; saveWs(); pushFiles();
  });

  // tasks / bug board
  const task = (id) => ws.tasks.find((t) => t.id === id);
  on('task:add', (p) => {
    const title = String(p.title || '').trim().slice(0, 120);
    if (!title || ws.tasks.length >= 300) return;
    ws.tasks.push({ id: crypto.randomUUID(), title, type: ['Bug', 'Task', 'Asset'].includes(p.type) ? p.type : 'Task', status: 'todo', by: s.data.name, assignee: null });
    saveWs(); pushTasks();
  });
  on('task:move', (p) => {
    const t = task(p.id);
    if (!t || !['todo', 'doing', 'done'].includes(p.status)) return;
    t.status = p.status;
    if (p.status === 'doing' && !t.assignee) t.assignee = s.data.name;
    saveWs(); pushTasks();
  });
  on('task:claim', (id) => { const t = task(id); if (t) { t.assignee = t.assignee === s.data.name ? null : s.data.name; saveWs(); pushTasks(); } });
  on('task:del', (id) => { ws.tasks = ws.tasks.filter((t) => t.id !== id); saveWs(); pushTasks(); });

  s.on('disconnect', () => {
    if ((ipSocket.get(s.data.ip) || {}).id === s.id) ipSocket.delete(s.data.ip);
    const hadEdit = s.data.editing, hadVoice = s.data.voice;
    leaveDoc(s); s.data.voice = false;
    leaveGames(s.id);
    io.emit('online', ipSocket.size);
    pushGames();
    if (hadEdit) pushFiles();
    if (hadVoice) pushVoice();
  });
});

server.listen(PORT, () => console.log('Common Room running on port ' + PORT));