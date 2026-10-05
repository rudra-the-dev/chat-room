const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const multer = require('multer');
const { Server } = require('socket.io');
const Doc = require('./crdt.js');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'messages.json');
const WS_FILE = path.join(DATA_DIR, 'workspace.json');
const MAX_FILE_MB = 10, MAX_MESSAGES = 300, MAX_FILES = 100;
const MAX_BUILD_MB = Number(process.env.MAX_BUILD_MB) || 100;
const BUILD_DIR = path.join(DATA_DIR, 'builds');
const CHANNELS = ['general', 'games', 'random', 'dev'];
const ROLES = ['Dev', 'Modeler', 'Tester', 'Other'];
const TEXT_EXT = /\.(txt|md|json|js|ts|py|gd|cs|cpp|h|lua|glsl|gdshader|tscn|tres|cfg|ini|ya?ml|xml|html|css|csv)$/i;

// Storage: with MONGODB_URI set, everything (messages, workspace files, tasks, uploads) lives in MongoDB.
// Without it, the old local-disk JSON + uploads folder is used.
const USE_MONGO = !!process.env.MONGODB_URI;
const TMP_DIR = USE_MONGO ? os.tmpdir() : UPLOAD_DIR;
if (!USE_MONGO) { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); fs.mkdirSync(BUILD_DIR, { recursive: true }); }
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const saver = (file, get) => { let t; return () => { clearTimeout(t); t = setTimeout(() => fs.writeFile(file, JSON.stringify(get()), () => {}), 300); }; };

let db = {}, ws = { files: {}, tasks: [], builds: [] }, mongo = null;
const logErr = (what) => (e) => console.error('mongo ' + what + ':', e.message);
const save = saver(DB_FILE, () => db);     // disk mode only
const saveWs = saver(WS_FILE, () => ws);   // disk mode only

function saveMsg(m) { if (USE_MONGO) mongo.msgs.insertOne({ _id: m.id, ...m }).catch(logErr('message')); else save(); }
function delMsg(m) { if (USE_MONGO) mongo.msgs.deleteOne({ _id: m.id }).catch(logErr('message delete')); else save(); }
function saveTasks() { if (USE_MONGO) mongo.meta.replaceOne({ _id: 'tasks' }, { _id: 'tasks', list: ws.tasks }, { upsert: true }).catch(logErr('tasks')); else saveWs(); }

function saveBuilds() { if (USE_MONGO) mongo.meta.replaceOne({ _id: 'builds' }, { _id: 'builds', list: ws.builds }, { upsert: true }).catch(logErr('builds')); else saveWs(); }
function postSystem(ch, text) {   // message from the "Common Room" bot
  const msg = { id: crypto.randomUUID(), ch, name: 'Common Room', role: 'Bot', text, time: Date.now() };
  db[ch].push(msg); saveMsg(msg);
  while (db[ch].length > MAX_MESSAGES) { const old = db[ch].shift(); if (old.file) unlinkUrl(old.file.url); delMsg(old); }
  io.emit('message', msg);
}

// One Mongo document per workspace file (text + saved versions). Mongo caps a document at 16 MB,
// so the oldest saved versions are dropped if a file plus its history gets too big.
const fileTimers = new Map();
const textSize = (f) => (f.content || '').length + f.history.reduce((n, h) => n + (h.content || '').length, 0);
function writeFile(name) {
  const f = ws.files[name];
  if (!f) return Promise.resolve();
  while (textSize(f) > 5e6 && f.history.length > 1) f.history.shift();
  return mongo.files.replaceOne({ _id: name }, { _id: name, ...f }, { upsert: true }).catch(logErr('file'));
}
function saveFile(name) {
  if (!USE_MONGO) return saveWs();
  clearTimeout(fileTimers.get(name));
  fileTimers.set(name, setTimeout(() => { fileTimers.delete(name); writeFile(name); }, 400));
}
function delFile(name) {
  if (!USE_MONGO) return saveWs();
  clearTimeout(fileTimers.get(name)); fileTimers.delete(name);
  mongo.files.deleteOne({ _id: name }).catch(logErr('file delete'));
}

async function init() {
  if (USE_MONGO) {
    const { MongoClient, GridFSBucket } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const d = client.db(process.env.MONGODB_DB || 'commonroom');
    mongo = { msgs: d.collection('messages'), files: d.collection('wsfiles'), meta: d.collection('meta'), bucket: new GridFSBucket(d, { bucketName: 'uploads' }) };
    await mongo.msgs.createIndex({ ch: 1, time: 1 });
    for (const c of CHANNELS) {
      const rows = await mongo.msgs.find({ ch: c }).sort({ time: -1 }).limit(MAX_MESSAGES).toArray();
      db[c] = rows.reverse().map(({ _id, ...m }) => m);
    }
    for (const f of await mongo.files.find().toArray()) { const { _id, ...rest } = f; ws.files[_id] = rest; }
    const t = await mongo.meta.findOne({ _id: 'tasks' });
    ws.tasks = t ? t.list : [];
    const bl = await mongo.meta.findOne({ _id: 'builds' });
    ws.builds = bl ? bl.list : [];
    console.log('Connected to MongoDB');
  } else {
    db = load(DB_FILE, {});
    if (Array.isArray(db)) db = { general: db };
    ws = load(WS_FILE, { files: {}, tasks: [] });
  }
  CHANNELS.forEach((c) => { db[c] = db[c] || []; });
  ws.files = ws.files || {}; ws.tasks = ws.tasks || []; ws.builds = ws.builds || [];
}

const SAFE_INLINE = { image: /\.(png|jpe?g|gif|webp)$/i, video: /\.(mp4|webm)$/i, audio: /\.(mp3|ogg|wav|m4a)$/i };
const kindOf = (f) => Object.keys(SAFE_INLINE).find((k) => SAFE_INLINE[k].test(f)) || 'file';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' };
const unlinkUrl = (u) => {
  const name = path.basename(u);
  if (!USE_MONGO) return fs.unlink(path.join(UPLOAD_DIR, name), () => {});
  mongo.bucket.find({ filename: name }).next().then((f) => f && mongo.bucket.delete(f._id)).catch(logErr('upload delete'));
};

function ipOf(headers, fallback) {
  return headers['cf-connecting-ip'] || (headers['x-forwarded-for'] || '').split(',')[0].trim() || fallback || 'unknown';
}
const cleanName = (n) => String(n || '').trim().slice(0, 24) || 'Guest';
const validName = (n) => typeof n === 'string' && /^[\w\-. \/]{1,60}$/.test(n) && !n.includes('..') && !n.startsWith('/');

const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    },
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
});

const uploadBuild = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + '.zip'),
  }),
  limits: { fileSize: MAX_BUILD_MB * 1024 * 1024, files: 1 },
});

// ---------- playable builds (web exports uploaded as .zip) ----------
function readZip(buf) {   // minimal zip reader (stored + deflate), no dependencies
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('That is not a valid .zip file.');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('Zip64 archives are not supported.');
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip.');
    const ent = { method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), usize: buf.readUInt32LE(p + 24), off: buf.readUInt32LE(p + 42) };
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    ent.name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    out.push(ent);
  }
  return out;
}
function zipData(buf, ent) {
  const o = ent.off;
  if (buf.readUInt32LE(o) !== 0x04034b50) throw new Error('Corrupt zip.');
  const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
  const raw = buf.subarray(start, start + ent.csize);
  if (ent.method === 0) return raw;
  if (ent.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: ent.usize + 1024 });
  throw new Error('Unsupported zip compression.');
}
async function putBuildFile(id, rel, data) {
  if (USE_MONGO) {
    await new Promise((ok, bad) => { const u = mongo.bucket.openUploadStream('b/' + id + '/' + rel); u.on('finish', ok).on('error', bad); u.end(data); });
  } else {
    const dest = path.join(BUILD_DIR, id, rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, data);
  }
}
async function deleteBuild(b) {
  try {
    if (USE_MONGO) {
      const rows = await mongo.bucket.find({ filename: { $regex: '^b/' + b.id + '/' } }).toArray();
      for (const f of rows) await mongo.bucket.delete(f._id);
    } else await fs.promises.rm(path.join(BUILD_DIR, b.id), { recursive: true, force: true });
  } catch (e) { console.error('delete build:', e.message); }
}
async function importBuild(zipPath, label, s) {
  const buf = await fs.promises.readFile(zipPath);
  let ents = readZip(buf).filter((e) => !e.name.endsWith('/') && !e.name.startsWith('/') &&
    !e.name.split('/').some((p) => p === '..' || p === '__MACOSX' || p === '.DS_Store'));
  const idx = ents.filter((e) => e.name.split('/').pop() === 'index.html').sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  if (!idx.length) throw new Error('No index.html found in the zip. Zip the contents of your web export folder.');
  const prefix = idx[0].name.slice(0, idx[0].name.length - 'index.html'.length);
  ents = ents.filter((e) => e.name.startsWith(prefix));
  const html = zipData(buf, idx[0]).toString('utf8');   // make sure the files index.html needs are really in the zip
  const have = new Set(ents.map((e) => e.name.slice(prefix.length)));
  const need = [];
  for (const m of html.matchAll(/<script[^>]+src=["']([^"':?#]+)["']/g)) if (!m[1].startsWith('/')) need.push(m[1].replace(/^\.\//, ''));
  const exe = /"executable"\s*:\s*"([^"]+)"/.exec(html);
  if (exe) need.push(exe[1] + '.wasm', exe[1] + '.pck');
  const missing = [...new Set(need)].filter((f) => !have.has(f));
  if (missing.length) throw new Error('Your zip is missing files the build needs: ' + missing.join(', ') + '. Zip ALL files from the export folder, not only index.html.');
  const total = ents.reduce((n, e) => n + e.usize, 0);
  if (ents.length > 1000 || total > 300e6) throw new Error('Build is too big (max 1000 files / 300 MB unpacked).');
  const id = crypto.randomBytes(5).toString('hex');
  try {
    for (const e of ents) await putBuildFile(id, e.name.slice(prefix.length), zipData(buf, e));
  } catch (e) { await deleteBuild({ id }); throw e; }
  return { id, name: label, by: s.data.name, role: s.data.role, time: Date.now(), files: ents.length, size: total };
}
const BUILD_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.txt': 'text/plain', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm' };

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 100e6 });
app.set('trust proxy', 1);

// Everything lives in the root folder, so only serve these three files (never server.js / data).
app.get(['/', '/index.html'], (q, r) => r.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.js', (q, r) => r.sendFile(path.join(__dirname, 'app.js')));
app.get('/crdt.js', (q, r) => r.sendFile(path.join(__dirname, 'crdt.js')));
app.get('/style.css', (q, r) => r.sendFile(path.join(__dirname, 'style.css')));
if (USE_MONGO) {
  app.get('/uploads/:name', async (req, res) => {
    try {
      const f = await mongo.bucket.find({ filename: req.params.name }).next();
      if (!f) return res.sendStatus(404);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', MIME[path.extname(f.filename).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Content-Length', f.length);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (kindOf(f.filename) === 'file') res.setHeader('Content-Disposition', 'attachment');
      mongo.bucket.openDownloadStream(f._id).on('error', () => res.end()).pipe(res);
    } catch (e) { res.sendStatus(500); }
  });
} else {
  app.use('/uploads', express.static(UPLOAD_DIR, {
    setHeaders(res, filePath) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (kindOf(filePath) === 'file') res.setHeader('Content-Disposition', 'attachment');
    },
  }));
}
app.get('/api/messages', (req, res) => res.json(db[req.query.ch] || []));

const lastPost = new Map();
setInterval(() => lastPost.clear(), 60000);

// Shared guard for both upload routes: rate limit, parse, and require a live socket from the same IP.
// keep() moves the uploaded temp file into permanent storage (GridFS in Mongo mode) and returns its URL.
function guarded(handler, uploader = upload) {
  return (req, res) => {
    const now = Date.now();
    const ip = ipOf(req.headers, req.ip);
    if (now - (lastPost.get(ip) || 0) < 800) return res.status(429).json({ error: 'Slow down a little.' });
    lastPost.set(ip, now);
    uploader.single('file')(req, res, async (err) => {
      const drop = () => req.file && fs.unlink(req.file.path, () => {});
      const keep = async () => {
        if (USE_MONGO) {
          await new Promise((ok, bad) => fs.createReadStream(req.file.path)
            .pipe(mongo.bucket.openUploadStream(req.file.filename)).on('finish', ok).on('error', bad));
          drop();
        }
        return '/uploads/' + req.file.filename;
      };
      try {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Files can be up to ${uploader === upload ? MAX_FILE_MB : MAX_BUILD_MB} MB.` : 'Upload failed.' });
        const s = io.sockets.sockets.get(String(req.body.sid || ''));
        if (!s || s.data.ip !== ip) { drop(); return res.status(403).json({ error: 'Not connected.' }); }
        await handler(req, res, s, now, drop, keep);
      } catch (e) { drop(); if (!res.headersSent) res.status(500).json({ error: 'Server error.' }); }
    });
  };
}

app.post('/api/post', guarded(async (req, res, s, now, drop, keep) => {
  const ch = String(req.body.ch);
  if (!CHANNELS.includes(ch)) { drop(); return res.status(400).json({ error: 'Unknown channel.' }); }
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text && !req.file) return res.status(400).json({ error: 'Write a message or attach a file.' });
  const msg = { id: crypto.randomUUID(), ch, name: s.data.name, role: s.data.role, text, time: now };
  if (req.file) msg.file = { url: await keep(), name: req.file.originalname.slice(0, 120), size: req.file.size, kind: kindOf(req.file.filename) };
  db[ch].push(msg);
  saveMsg(msg);
  while (db[ch].length > MAX_MESSAGES) {
    const old = db[ch].shift();
    if (old.file) unlinkUrl(old.file.url);
    delMsg(old);
  }
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
  if (d && f && f.kind === 'text') { f.content = d.doc.text(); f.size = f.content.length; saveFile(name); }
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
  saveFile(name); pushFiles();
  io.emit('ws:updated', { name, v: f.v, by: e.by });
  return f.v;
}

app.post('/api/asset', guarded(async (req, res, s, now, drop, keep) => {
  if (!req.file) return res.status(400).json({ error: 'No file.' });
  const name = validName(req.body.name) ? req.body.name : req.file.originalname.replace(/[^\w\-. ]/g, '_').slice(0, 60);
  if (!ws.files[name] && Object.keys(ws.files).length >= MAX_FILES) { drop(); return res.status(400).json({ error: 'Workspace is full.' }); }
  if (TEXT_EXT.test(name)) {
    const content = fs.readFileSync(req.file.path, 'utf8');
    drop();
    commit(s, name, { content }, req.body.note);
  } else {
    commit(s, name, { url: await keep(), size: req.file.size }, req.body.note);
  }
  res.json({ ok: true });
}));

// Play a build: /play/<id>/ serves the unzipped export. By default builds run sandboxed (opaque origin, no access to
// this site's storage). Set BUILD_SANDBOX=0 for threaded Godot builds that need cross-origin isolation (trusted use only).
app.get('/play/:id', (req, res, next) => {
  if (req.path.endsWith('/')) return next();   // already has the slash: let the route below serve it (no redirect loop)
  res.redirect('/play/' + req.params.id + '/');
});
app.get('/play/:id/*', async (req, res) => {
  try {
    const id = req.params.id;
    let rel = req.params[0] || 'index.html';
    if (!/^[a-f0-9]{10}$/.test(id) || rel.split('/').includes('..')) return res.sendStatus(404);
    if (rel.endsWith('/')) rel += 'index.html';
    const enc = /\.gz$/.test(rel) ? 'gzip' : /\.br$/.test(rel) ? 'br' : null;
    const type = BUILD_MIME[path.extname(enc ? rel.replace(/\.(gz|br)$/, '') : rel).toLowerCase()] || 'application/octet-stream';
    let stream, size;
    if (USE_MONGO) {
      const f = await mongo.bucket.find({ filename: 'b/' + id + '/' + rel }).sort({ uploadDate: -1 }).limit(1).next();
      if (!f) return res.sendStatus(404);
      size = f.length; stream = mongo.bucket.openDownloadStream(f._id);
    } else {
      const file = path.resolve(BUILD_DIR, id, rel);
      if (!file.startsWith(path.resolve(BUILD_DIR, id) + path.sep) || !fs.existsSync(file)) return res.sendStatus(404);
      size = fs.statSync(file).size; stream = fs.createReadStream(file);
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', size);
    if (enc) res.setHeader('Content-Encoding', enc);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (process.env.BUILD_SANDBOX === '0') {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    } else res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-pointer-lock allow-popups allow-forms allow-modals allow-downloads');
    stream.on('error', () => res.end()).pipe(res);
  } catch (e) { res.sendStatus(500); }
});

app.post('/api/build', guarded(async (req, res, s, now, drop) => {
  try {
    if (!req.file) throw new Error('No file.');
    if (!/\.zip$/i.test(req.file.originalname)) throw new Error('Upload a .zip of your web export.');
    const label = String(req.body.name || '').trim().slice(0, 60) || req.file.originalname.replace(/\.zip$/i, '').slice(0, 60);
    const b = await importBuild(req.file.path, label, s);
    ws.builds.unshift(b);
    while (ws.builds.length > 10) deleteBuild(ws.builds.pop());
    saveBuilds(); io.emit('builds', ws.builds);
    postSystem('dev', `🎮 ${s.data.name} uploaded a playable build "${b.name}": ${req.protocol}://${req.get('host')}/play/${b.id}/`);
    res.json({ ok: true, id: b.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
  finally { drop(); }
}, uploadBuild));

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
  board: g.board, turn: g.turn, picked: Object.keys(g.picks), shown: g.shown, hc: g.hc, hf: g.hf,
});
const pushGames = () => io.emit('games', [...games.values()].map(pub));
const reset = (g) => {
  g.board = Array(g.type === 'c4' ? 42 : 9).fill('');
  g.turn = g.type === 'c4' ? 'R' : 'X';
  g.picks = {}; g.shown = null; g.winner = null; g.status = g.guest ? 'playing' : 'waiting';
  g.hc = null; g.hf = null;   // the toss happens only once both players are in
  if (g.guest && g.type === 'hf') hfInit(g);
  if (g.guest && g.type === 'hc') g.hc = { batter: Math.random() < 0.5 ? 'host' : 'guest', innings: 1, scores: { host: 0, guest: 0 }, target: null, last: null, log: [] };
};
const leaveGames = (sid) => { for (const [id, g] of games) if (g.host.sid === sid || (g.guest && g.guest.sid === sid)) games.delete(id); };
const inGame = (sid) => [...games.values()].some((g) => g.host.sid === sid || (g.guest && g.guest.sid === sid));

// ---------- hand cricket ----------
// Both throw at once. Same number = batter is OUT, otherwise the batter scores their number.
// Innings 1: batter plays until out. Innings 2: chaser must beat the target.
const HC_VALUES = [1, 2, 3, 4, 5, 6, 10, 20];
function hcMove(g, sid, v) {
  if (!HC_VALUES.includes(v) || g.picks[sid] !== undefined) return;
  g.picks[sid] = v;
  const h = g.hc, bat = h.batter === 'host' ? g.host.sid : g.guest.sid, bowl = h.batter === 'host' ? g.guest.sid : g.host.sid;
  if (g.picks[bat] === undefined || g.picks[bowl] === undefined) return;
  const b = g.picks[bat], w = g.picks[bowl], out = b === w;
  g.picks = {};
  h.last = { bat: b, bowl: w, out };
  h.log.unshift({ bat: b, out });
  if (h.log.length > 8) h.log.length = 8;
  if (!out) {
    h.scores[h.batter] += b;
    if (h.innings === 2 && h.scores[h.batter] > h.target) { g.winner = h.batter === 'host' ? g.host.sid : g.guest.sid; g.status = 'done'; }
    return;
  }
  if (h.innings === 1) { h.target = h.scores[h.batter]; h.innings = 2; h.batter = h.batter === 'host' ? 'guest' : 'host'; return; }
  g.status = 'done';
  g.winner = h.scores[h.batter] === h.target ? 'draw' : (h.batter === 'host' ? g.guest.sid : g.host.sid);
}

// ---------- hand football ----------
// Both show 1-6 fingers at once. Same number = the player with the ball scores and the ball changes sides.
// Otherwise an even sum changes possession, an odd sum keeps it. 20 attempts; attempt 11 is a free penalty for the
// player with the ball. Level = toss + 10 attempts extra time. Still level = toss + penalty shootout (5 tries each,
// then repeated 3-try rounds, each with a new toss, until someone wins). Penalty: attacker and keeper each show
// index / index+middle / thumb; if they differ it is a goal.
const HF_PEN = ['index', 'index+middle', 'thumb'];
const hfOther = (x) => (x === 'host' ? 'guest' : 'host');
const hfName = (g, x) => (x === 'host' ? g.host.name : g.guest.name);
function hfToss(g, why) {
  const winner = Math.random() < 0.5 ? 'host' : 'guest';
  g.hf.toss = { winner, why };
  return winner;
}
function hfInit(g) {
  g.hf = { phase: 'play', stage: 'main', attempt: 1, max: 20, score: { host: 0, guest: 0 }, poss: null, toss: null,
    pen: null, round: 1, penHistory: [], last: '', log: [] };
  g.hf.poss = hfToss(g, 'the ball');
  hfSay(g, `Toss: ${hfName(g, g.hf.poss)} wins and starts with the ball.`);
}
function hfSay(g, text) { const h = g.hf; h.last = text; h.log.unshift(text); if (h.log.length > 6) h.log.length = 6; }
function hfAppend(g, text) { const h = g.hf; h.last += ' ' + text; h.log[0] = h.last; }
function hfFinish(g, side) { g.hf.phase = 'done'; g.status = 'done'; g.winner = side === 'host' ? g.host.sid : g.guest.sid; }
function hfAdvance(g) {   // after a normal / free-penalty attempt in main time or extra time
  const h = g.hf;
  h.attempt++;
  if (h.attempt <= h.max) return;
  if (h.score.host !== h.score.guest) return hfFinish(g, h.score.host > h.score.guest ? 'host' : 'guest');
  if (h.stage === 'main') {
    h.stage = 'extra'; h.attempt = 1; h.max = 10;
    h.poss = hfToss(g, 'extra time');
    hfAppend(g, `Level at full time! Toss: ${hfName(g, h.poss)} wins and starts extra time with the ball.`);
  } else {
    hfToss(g, 'the shootout');
    h.phase = 'choose'; h.pen = { tries: 5 };
    hfAppend(g, `Still level after extra time! Toss: ${hfName(g, h.toss.winner)} wins and chooses to attack or defend first in the shootout.`);
  }
}
function hfPenAdvance(g) {   // after a shootout attempt
  const h = g.hf, p = h.pen;
  if (p.taken < p.tries) return;
  if (p.half === 1) { p.half = 2; p.attacker = hfOther(p.attacker); p.taken = 0; return; }
  const f = p.first, o = hfOther(f);
  h.penHistory.push({ host: p.goals.host, guest: p.goals.guest });
  if (p.goals[f] !== p.goals[o]) return hfFinish(g, p.goals[f] > p.goals[o] ? f : o);
  h.round++;
  hfToss(g, 'the next penalty round');
  h.phase = 'choose'; h.pen = { tries: 3 };
  hfAppend(g, `Shootout level ${p.goals.host}-${p.goals.guest}! Toss for a 3-try round: ${hfName(g, h.toss.winner)} wins and chooses.`);
}
function hfMove(g, sid, v) {
  const h = g.hf, me = sid === g.host.sid ? 'host' : 'guest';
  if (h.phase === 'choose') {   // toss winner picks attack or defend first
    if (me !== h.toss.winner || (v !== 'attack' && v !== 'defend')) return;
    const first = v === 'attack' ? me : hfOther(me);
    h.pen = { tries: h.pen.tries, half: 1, first, attacker: first, taken: 0, goals: { host: 0, guest: 0 } };
    h.stage = 'pens'; h.phase = 'play'; g.picks = {};
    hfSay(g, `${hfName(g, me)} chose to ${v} first, so ${hfName(g, first)} shoots first.`);
    return;
  }
  if (h.phase !== 'play' || g.picks[sid] !== undefined) return;
  const penalty = h.stage === 'pens' || (h.stage === 'main' && h.attempt === 11);
  if (penalty ? !HF_PEN.includes(v) : !(Number.isInteger(v) && v >= 1 && v <= 6)) return;
  g.picks[sid] = v;
  const a = g.picks[g.host.sid], b = g.picks[g.guest.sid];
  if (a === undefined || b === undefined) return;
  g.picks = {};
  const H = hfName(g, 'host'), G = hfName(g, 'guest');
  if (!penalty) {
    const att = h.poss, def = hfOther(att), sum = a + b;
    if (a === b) { h.score[att]++; h.poss = def; hfSay(g, `${H} ${a} · ${G} ${b}: same number! GOAL for ${hfName(g, att)}. Ball goes to ${hfName(g, def)}.`); }
    else if (sum % 2 === 0) { h.poss = def; hfSay(g, `${H} ${a} · ${G} ${b}: even sum (${sum}). Ball goes to ${hfName(g, def)}.`); }
    else hfSay(g, `${H} ${a} · ${G} ${b}: odd sum (${sum}). ${hfName(g, att)} keeps the ball.`);
    hfAdvance(g);
    return;
  }
  const att = h.stage === 'pens' ? h.pen.attacker : h.poss, goal = a !== b;
  const pa = att === 'host' ? a : b, pd = att === 'host' ? b : a;
  hfSay(g, `Penalty: ${hfName(g, att)} showed ${pa}, ${hfName(g, hfOther(att))} showed ${pd} → ${goal ? 'GOAL!' : 'SAVED!'}`);
  if (h.stage === 'pens') { if (goal) h.pen.goals[att]++; h.pen.taken++; hfPenAdvance(g); }
  else { if (goal) h.score[att]++; h.poss = hfOther(att); hfAdvance(g); }
}

// ---------- voice ----------
const voiceList = () => [...io.sockets.sockets.values()].filter((x) => x.data.voice).map((x) => ({ id: x.id, name: x.data.name }));
const pushVoice = () => io.emit('voice:list', voiceList());
const pushUsers = () => io.emit('users', [...io.sockets.sockets.values()].map((x) => ({ name: x.data.name, role: x.data.role })));
const done = (cb, o) => typeof cb === 'function' && cb(o);

io.on('connection', (s) => {
  const on = (ev, fn) => s.on(ev, (...a) => { try { fn(...a); } catch (e) { console.error(ev, e.message); } });
  io.emit('online', ipSocket.size);
  s.emit('games', [...games.values()].map(pub));
  s.emit('tasks', ws.tasks);
  s.emit('voice:list', voiceList());
  pushFiles(); s.emit('builds', ws.builds); pushUsers();

  on('hello', (p) => {
    p = p || {};
    s.data.name = cleanName(p.name);
    s.data.role = ROLES.includes(p.role) ? p.role : 'Other';
    if (s.data.voice) pushVoice();
    pushUsers();
  });

  // games
  on('game:create', (type) => {
    if (!ROLES_OF[type] && type !== 'rps' && type !== 'hc' && type !== 'hf') return;
    if (inGame(s.id)) return;
    const g = { id: crypto.randomBytes(4).toString('hex'), type, host: { sid: s.id, name: s.data.name }, guest: null };
    reset(g); games.set(g.id, g); pushGames();
  });
  on('game:join', (id) => {
    const g = games.get(id);
    if (!g || g.guest || inGame(s.id)) return;
    g.guest = { sid: s.id, name: s.data.name };
    reset(g);   // fresh game state, and the toss happens now that both players are here
    pushGames();
  });
  on('game:move', (p) => {
    const { id, v } = p;
    const g = games.get(id);
    if (!g || g.status !== 'playing') return;
    const isHost = g.host.sid === s.id;
    if (!isHost && !(g.guest && g.guest.sid === s.id)) return;
    if (g.type === 'hc') { hcMove(g, s.id, v); pushGames(); return; }
    if (g.type === 'hf') { hfMove(g, s.id, v); pushGames(); return; }
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
    delete ws.files[name]; delFile(name); pushFiles();
  });

  on('build:del', (id) => {
    const i = ws.builds.findIndex((b) => b.id === id);
    if (i < 0) return;
    deleteBuild(ws.builds.splice(i, 1)[0]);
    saveBuilds(); io.emit('builds', ws.builds);
  });

  // tasks / bug board
  const task = (id) => ws.tasks.find((t) => t.id === id);
  on('task:add', (p) => {
    const title = String(p.title || '').trim().slice(0, 120);
    if (!title || ws.tasks.length >= 300) return;
    ws.tasks.push({ id: crypto.randomUUID(), title, type: ['Bug', 'Task', 'Asset'].includes(p.type) ? p.type : 'Task', status: 'todo', by: s.data.name, assignee: null });
    saveTasks(); pushTasks();
  });
  on('task:move', (p) => {
    const t = task(p.id);
    if (!t || !['todo', 'doing', 'done'].includes(p.status)) return;
    t.status = p.status;
    if (p.status === 'doing' && !t.assignee) t.assignee = s.data.name;
    saveTasks(); pushTasks();
  });
  on('task:claim', (id) => { const t = task(id); if (t) { t.assignee = t.assignee === s.data.name ? null : s.data.name; saveTasks(); pushTasks(); } });
  on('task:del', (id) => { ws.tasks = ws.tasks.filter((t) => t.id !== id); saveTasks(); pushTasks(); });

  s.on('disconnect', () => {
    if ((ipSocket.get(s.data.ip) || {}).id === s.id) ipSocket.delete(s.data.ip);
    const hadEdit = s.data.editing, hadVoice = s.data.voice;
    leaveDoc(s); s.data.voice = false;
    leaveGames(s.id);
    io.emit('online', ipSocket.size);
    pushGames(); pushUsers();
    if (hadEdit) pushFiles();
    if (hadVoice) pushVoice();
  });
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const name of [...docs.keys()]) flush(name);   // write out live edits before the process dies
  if (USE_MONGO) {
    const names = [...fileTimers.keys()];
    names.forEach((n) => clearTimeout(fileTimers.get(n)));
    fileTimers.clear();
    await Promise.all(names.map(writeFile));
  } else {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); fs.writeFileSync(WS_FILE, JSON.stringify(ws)); } catch {}
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

init()
  .then(() => server.listen(PORT, () => console.log('Common Room running on port ' + PORT + (USE_MONGO ? ' (MongoDB)' : ' (local disk)'))))
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
