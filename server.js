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
const BUILD_DIR = path.join(DATA_DIR, 'builds');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_FILE_MB = 10, MAX_MESSAGES = 300, MAX_FILES = 100;
const MAX_BUILD_MB = Number(process.env.MAX_BUILD_MB) || 100;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const RESERVED = (process.env.RESERVED_NAMES || 'admin,administrator,moderator,mod,system,owner,rudra,staff,support,commonroom,everyone,all').split(',');
const JOBS = ['Dev', 'Modeler', 'Tester', 'Other'];
const RANK = { member: 1, mod: 2, admin: 3, owner: 4 };
const DM_MIN_AGE = process.env.DM_MIN_AGE_MS !== undefined ? Number(process.env.DM_MIN_AGE_MS) : 120000;
const LIM = { owned: 5, joined: 25, members: 200, channels: 10, invites: 20 };
const TEXT_EXT = /\.(txt|md|json|js|ts|py|gd|cs|cpp|h|lua|glsl|gdshader|tscn|tres|cfg|ini|ya?ml|xml|html|css|csv)$/i;
const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ======================= small helpers =======================
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const now = () => Date.now();
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const safeEq = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
const randCode = (n) => { const b = crypto.randomBytes(n); let s = ''; for (let i = 0; i < n; i++) s += CODE_ALPHA[b[i] % CODE_ALPHA.length]; return s; };
const hits = new Map();
function rate(key, max, ms) {   // true if allowed; counts this hit
  const t = now(), a = (hits.get(key) || []).filter((x) => t - x < ms);
  if (a.length >= max) { hits.set(key, a); return false; }
  a.push(t); hits.set(key, a); return true;
}
setInterval(() => { const t = now(); for (const [k, a] of hits) if (!a.length || t - a[a.length - 1] > 3600e3) hits.delete(k); }, 600e3).unref();

// ======================= storage =======================
// With MONGODB_URI set everything lives in MongoDB (uploads in GridFS). Without it, one JSON file on local disk.
// All data is also held in memory and written through on every change.
const USE_MONGO = !!process.env.MONGODB_URI;
const TMP_DIR = USE_MONGO ? os.tmpdir() : UPLOAD_DIR;
if (!USE_MONGO) { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); fs.mkdirSync(BUILD_DIR, { recursive: true }); }
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const logErr = (what) => (e) => console.error('mongo ' + what + ':', e.message);

const users = new Map(), byName = new Map(), byToken = new Map(), servers = new Map(), inviteIdx = new Map(), dms = new Map();
const msgs = {};   // 'serverId|channelId' -> [messages]
let reports = [], audit = [], meta = { _id: 'meta', banIps: [] };
let mongo = null;
const col = (n) => mongo[n];

const pend = new Map();
function later(key, run) {
  const p = pend.get(key); if (p) clearTimeout(p.t);
  const t = setTimeout(() => { pend.delete(key); run(); }, 300);
  pend.set(key, { t, run });
}
async function flushAll() {
  const runs = [...pend.values()]; pend.clear();
  runs.forEach((p) => clearTimeout(p.t));
  await Promise.all(runs.map((p) => p.run()));
}
let diskTimer = null;
const dirty = () => { if (USE_MONGO) return; clearTimeout(diskTimer); diskTimer = setTimeout(saveDisk, 500); };
function saveDisk() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ users: [...users.values()], servers: [...servers.values()], msgs, dms: [...dms.values()], reports, audit: audit.slice(-500), meta }));
  } catch (e) { console.error('save:', e.message); }
}
function put(coll, doc) {
  if (!USE_MONGO) return dirty();
  later(coll + '|' + doc._id, () => col(coll).replaceOne({ _id: doc._id }, doc, { upsert: true }).catch(logErr(coll)));
}
function dropDoc(coll, id) {
  if (!USE_MONGO) return dirty();
  const k = coll + '|' + id, p = pend.get(k);
  if (p) { clearTimeout(p.t); pend.delete(k); }
  col(coll).deleteOne({ _id: id }).catch(logErr(coll + ' delete'));
}
const putUser = (u) => put('users', u);
const putServer = (srv) => put('servers', USE_MONGO ? (({ files, ...rest }) => rest)(srv) : srv);
const putReport = (r) => put('reports', r);
const putMeta = () => put('meta', meta);
const fkey = (srv, name) => srv._id + '|' + name;
const textSize = (f) => (f.content || '').length + f.history.reduce((n, h) => n + (h.content || '').length, 0);
function putFile(srv, name) {   // workspace file (text + saved versions); Mongo caps a document at 16 MB
  if (!USE_MONGO) return dirty();
  later('wsfiles|' + fkey(srv, name), () => {
    const f = srv.files[name]; if (!f) return;
    while (textSize(f) > 5e6 && f.history.length > 1) f.history.shift();
    return col('wsfiles').replaceOne({ _id: fkey(srv, name) }, { _id: fkey(srv, name), ...f, server: srv._id }, { upsert: true }).catch(logErr('file'));
  });
}
const dropFile = (srv, name) => dropDoc('wsfiles', fkey(srv, name));
function putMsg(m) { if (USE_MONGO) col('msgs').replaceOne({ _id: m.id }, { _id: m.id, ...m }, { upsert: true }).catch(logErr('message')); else dirty(); }
function dropMsg(m) { if (USE_MONGO) col('msgs').deleteOne({ _id: m.id }).catch(logErr('message delete')); else dirty(); }
function log(by, action, target, info) {   // audit trail of sensitive actions
  const e = { _id: rid(6), time: now(), by: by || null, action, target: target || null, info: String(info || '').slice(0, 200) };
  audit.push(e); if (audit.length > 1000) audit.shift();
  if (USE_MONGO) col('audit').insertOne({ ...e }).catch(logErr('audit')); else dirty();
}

// ======================= models =======================
const chanKey = (sid, ch) => sid + '|' + ch;
const chanMsgs = (sid, ch) => msgs[chanKey(sid, ch)] || (msgs[chanKey(sid, ch)] = []);
function newServer(id, name, owner, lobby) {
  return {
    _id: id, name, owner, lobby: !!lobby, created: now(),
    members: owner ? { [owner]: 'owner' } : {},      // uid -> role (lobby: only elevated roles are listed)
    channels: lobby ? ['general', 'games', 'random', 'dev'].map((n) => ({ id: n, name: n })) : [{ id: 'general', name: 'general' }],
    invites: [], tasks: [], builds: [], muted: {}, banned: {}, files: {},
  };
}
function ensureLobby() {
  let l = servers.get('lobby');
  if (!l) { l = newServer('lobby', 'Common Room', null, true); servers.set('lobby', l); putServer(l); }
  return l;
}
function roleIn(srv, uid) {
  const u = users.get(uid);
  if (!u || u.banned || srv.banned[uid]) return null;
  if (srv.lobby) return u.admin ? 'owner' : (srv.members[uid] || 'member');
  return srv.members[uid] || null;
}
const rankIn = (srv, uid) => RANK[roleIn(srv, uid)] || 0;
const card = (u) => ({ uid: u._id, username: u.username, display: u.display, bio: u.bio, status: u.status, avatar: u.avatar, job: u.job, admin: !!u.admin, created: u.created });
const meInfo = (u) => ({ ...card(u), servers: u.servers, blocked: u.blocked, dmOff: !!u.dmOff, mutedUntil: u.mutedUntil || 0 });
const serverList = (u) => ['lobby', ...u.servers].map((id) => servers.get(id)).filter(Boolean).map((srv) => ({ id: srv._id, name: srv.name, lobby: !!srv.lobby, role: roleIn(srv, u._id), members: srv.lobby ? null : Object.keys(srv.members).length }));
function cleanAvatar(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.t === 'emoji') return { t: 'emoji', v: clip(a.v, 8) || '🙂', c: /^#[0-9a-f]{6}$/i.test(a.c) ? a.c : '#5865f2' };
  if (a.t === 'img' && typeof a.v === 'string' && a.v.length <= 40000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(a.v)) return { t: 'img', v: a.v };
  return null;
}
const safeUrlName = (n) => String(n || '').replace(/[^\w\-. ]/g, '_').slice(0, 60);
const validName = (n) => typeof n === 'string' && /^[\w\-. \/]{1,60}$/.test(n) && !n.includes('..') && !n.startsWith('/');

// ---------- loading ----------
async function loadMongo() {
  const { MongoClient, GridFSBucket } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const d = client.db(process.env.MONGODB_DB || 'commonroom');
  mongo = { users: d.collection('users'), servers: d.collection('servers'), msgs: d.collection('messages'), wsfiles: d.collection('wsfiles'),
    dms: d.collection('dms'), reports: d.collection('reports'), audit: d.collection('audit'), meta: d.collection('meta'), bucket: new GridFSBucket(d, { bucketName: 'uploads' }) };
  await mongo.msgs.createIndex({ server: 1, ch: 1, time: 1 });
  await mongo.msgs.updateMany({ server: { $exists: false } }, { $set: { server: 'lobby' } });   // single-room data becomes the lobby
  for (const u of await mongo.users.find().toArray()) users.set(u._id, u);
  for (const s of await mongo.servers.find().toArray()) { s.files = {}; servers.set(s._id, s); }
  const mm = await mongo.meta.findOne({ _id: 'meta' }); if (mm) meta = mm;
  if (!servers.has('lobby')) {   // first start after upgrading: adopt the old tasks and builds
    const lobby = ensureLobby();
    const mt = await mongo.meta.findOne({ _id: 'tasks' }), mb = await mongo.meta.findOne({ _id: 'builds' });
    lobby.tasks = mt ? mt.list : []; lobby.builds = mb ? mb.list : []; putServer(lobby);
  }
  for (const f of await mongo.wsfiles.find().toArray()) {
    const { _id, ...rest } = f, srv = servers.get(f.server || 'lobby');
    if (!srv) continue;
    srv.files[rest.name] = rest;
    if (!f.server) { putFile(srv, rest.name); mongo.wsfiles.deleteOne({ _id }).catch(logErr('legacy file')); }
  }
  for (const t of await mongo.dms.find().toArray()) dms.set(t._id, t);
  reports = await mongo.reports.find().sort({ time: -1 }).limit(500).toArray();
  audit = (await mongo.audit.find().sort({ time: -1 }).limit(500).toArray()).reverse();
  for (const srv of servers.values()) for (const c of srv.channels) {
    const rows = await mongo.msgs.find({ server: srv._id, ch: c.id }).sort({ time: -1 }).limit(MAX_MESSAGES).toArray();
    msgs[chanKey(srv._id, c.id)] = rows.reverse().map(({ _id, ...m }) => m);
  }
}
function loadDisk() {
  const d = load(STATE_FILE, null);
  if (d) {
    (d.users || []).forEach((u) => users.set(u._id, u));
    (d.servers || []).forEach((s) => { s.files = s.files || {}; servers.set(s._id, s); });
    Object.assign(msgs, d.msgs || {});
    (d.dms || []).forEach((t) => dms.set(t._id, t));
    reports = d.reports || []; audit = d.audit || []; meta = d.meta || meta;
  } else {   // first start after upgrading from the single-room version
    const lobby = ensureLobby();
    const oldMsgs = load(path.join(DATA_DIR, 'messages.json'), {}), oldWs = load(path.join(DATA_DIR, 'workspace.json'), null);
    for (const c of lobby.channels) msgs[chanKey('lobby', c.id)] = (Array.isArray(oldMsgs[c.id]) ? oldMsgs[c.id] : []).map((m) => ({ ...m, server: 'lobby' }));
    if (oldWs) { lobby.files = oldWs.files || {}; lobby.tasks = oldWs.tasks || []; lobby.builds = oldWs.builds || []; }
    dirty();
  }
}
function indexAll() {
  byName.clear(); byToken.clear(); inviteIdx.clear();
  for (const u of users.values()) { byName.set(u.username.toLowerCase(), u._id); u.tokens.forEach((t) => byToken.set(t, u._id)); }
  for (const srv of servers.values()) srv.invites.forEach((i) => inviteIdx.set(i.code, srv._id));
}
async function init() {
  if (USE_MONGO) await loadMongo(); else loadDisk();
  ensureLobby();
  meta.banIps = meta.banIps || [];
  indexAll();
  purgeOld();
  console.log(USE_MONGO ? 'Connected to MongoDB' : 'Using local disk storage');
}
function purgeOld() {   // deleted messages are kept 7 days (evidence for reports); DMs 30 days; expired invites
  const t = now();
  for (const k of Object.keys(msgs)) {
    const keep = msgs[k].filter((m) => !(m.deleted && t - m.deleted.time > 7 * 86400e3));
    if (keep.length !== msgs[k].length) { msgs[k].filter((m) => !keep.includes(m)).forEach(dropMsg); msgs[k] = keep; }
  }
  for (const th of dms.values()) {
    const keep = th.msgs.filter((m) => t - m.time < 30 * 86400e3);
    if (keep.length !== th.msgs.length) { th.msgs = keep; put('dms', th); }
  }
  for (const srv of servers.values()) {
    const keep = srv.invites.filter((i) => !i.revoked && (!i.expires || i.expires > t));
    if (keep.length !== srv.invites.length) { srv.invites.filter((i) => !keep.includes(i)).forEach((i) => inviteIdx.delete(i.code)); srv.invites = keep; putServer(srv); }
  }
}
setInterval(purgeOld, 3600e3).unref();

// ======================= accounts =======================
const newRecoveryCode = () => randCode(16).match(/.{4}/g).join('-');
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const codeHash = (c) => sha('recovery:' + normCode(c));
function register(s, p) {
  if (!rate('reg:' + s.data.ip, 3, 24 * 3600e3)) return { error: 'Too many new accounts from this network today.' };
  const name = clip(p.username, 20);
  if (!USERNAME.test(name)) return { error: 'Username must be 3-20 letters, numbers or underscores.' };
  const key = name.toLowerCase();
  const adminKey = !!(ADMIN_KEY && p.adminKey && safeEq(String(p.adminKey), ADMIN_KEY));
  if (RESERVED.includes(key) && !adminKey) return { error: 'That username is reserved.' };
  if (byName.has(key)) return { error: 'That username is taken.' };
  const display = clip(p.display, 24) || name, code = newRecoveryCode();
  const u = { _id: rid(8), username: name, display, bio: '', status: '', avatar: { t: 'emoji', v: '🙂', c: '#5865f2' }, job: JOBS.includes(p.job) ? p.job : 'Other',
    tokens: [s.data.th], recovery: codeHash(code), created: now(), nameChanged: 0, nameHistory: [{ name: display, time: now() }],
    admin: adminKey, mutedUntil: 0, banned: null, blocked: [], dmOff: false, servers: [] };
  users.set(u._id, u); byName.set(key, u._id); byToken.set(s.data.th, u._id); putUser(u);
  return { u, code };
}
function recover(s, p) {
  const key = clip(p.username, 20).toLowerCase();
  if (!rate('rec:ip:' + s.data.ip, 10, 600e3) || !rate('rec:' + key, 8, 600e3)) return { error: 'Too many attempts. Try again in a few minutes.' };
  const u = users.get(byName.get(key));
  if (!u || !safeEq(u.recovery, codeHash(p.code))) return { error: 'Username or recovery code is wrong.' };
  if (u.banned) return { error: 'This account is banned.' };
  if (!u.tokens.includes(s.data.th)) {
    u.tokens.push(s.data.th); byToken.set(s.data.th, u._id);
    if (u.tokens.length > 5) byToken.delete(u.tokens.shift());
    putUser(u);
  }
  return { u };
}

// ======================= files, uploads, builds =======================
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

// Everything lives in the root folder, so only these files are served (never server.js / data).
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

// ======================= presence, servers, state =======================
const socketsOf = (uid) => { const r = io.sockets.adapter.rooms.get('user:' + uid); return r ? [...r].map((id) => io.sockets.sockets.get(id)).filter(Boolean) : []; };
const isOnline = (uid) => socketsOf(uid).length > 0;
function onlineIn(srv) {
  if (srv.lobby) { const set = new Set(); for (const x of io.sockets.sockets.values()) if (x.data.uid) set.add(x.data.uid); return [...set]; }
  return Object.keys(srv.members).filter(isOnline);
}
const presence = (srv) => io.to('chat:' + srv._id).emit('presence', { server: srv._id, online: onlineIn(srv) });
function presenceFor(u) { presence(servers.get('lobby')); u.servers.forEach((id) => { const s = servers.get(id); if (s) presence(s); }); }

function fileMeta(srv) {
  const ed = {};
  for (const x of io.sockets.sockets.values()) if (x.data.editing && x.data.editing.srv === srv._id) (ed[x.data.editing.name] = ed[x.data.editing.name] || []).push(x.data.name);
  return Object.values(srv.files).map((f) => ({ name: f.name, kind: f.kind, v: f.v, by: f.by, role: f.role, time: f.time, size: f.size, editing: ed[f.name] || [] }));
}
const pushFiles = (srv) => io.to('srv:' + srv._id).emit('ws:files', fileMeta(srv));
const pushTasks = (srv) => io.to('srv:' + srv._id).emit('tasks', srv.tasks);
const pushBuilds = (srv) => io.to('srv:' + srv._id).emit('builds', srv.builds);
const voiceList = (sid) => [...io.sockets.sockets.values()].filter((x) => x.data.voice === sid).map((x) => ({ id: x.id, name: x.data.name }));
const pushVoice = (sid) => io.to('srv:' + sid).emit('voice:list', voiceList(sid));

function stateFor(s, srv) {
  const role = roleIn(srv, s.data.uid), r = RANK[role] || 0;
  const st = { id: srv._id, name: srv.name, lobby: !!srv.lobby, role, owner: srv.owner, channels: srv.channels, roles: srv.members,
    memberIds: srv.lobby ? null : Object.keys(srv.members), online: onlineIn(srv), tasks: srv.tasks, builds: srv.builds, files: fileMeta(srv),
    games: serverGames(srv._id).map(pub), voice: voiceList(srv._id) };
  if (r >= RANK.admin) {
    st.invites = srv.invites.map((i) => ({ code: i.code, uses: i.uses, max: i.max, expires: i.expires }));
    st.banned = Object.keys(srv.banned);
  }
  return st;
}
function pushState(srv) {
  const r = io.sockets.adapter.rooms.get('srv:' + srv._id);
  if (r) for (const id of [...r]) { const x = io.sockets.sockets.get(id); if (x) x.emit('server:state', stateFor(x, srv)); }
}
function leaveActive(s) {   // leave everything that is scoped to the active server
  const old = s.data.srv; if (!old) return;
  leaveDoc(s); leaveGames(s.id);
  if (s.data.voice) { const v = s.data.voice; s.data.voice = null; pushVoice(v); }
  s.leave('srv:' + old); s.data.srv = null;
}
function openServer(s, id) {
  const srv = servers.get(id);
  if (!srv || !s.data.uid || !roleIn(srv, s.data.uid)) return null;
  if (s.data.srv && s.data.srv !== id) leaveActive(s);
  s.data.srv = id; s.join('srv:' + id);
  return srv;
}
function toLobby(x) { leaveActive(x); const l = openServer(x, 'lobby'); if (l) x.emit('server:state', stateFor(x, l)); }
function login(s, u) {
  s.data.uid = u._id; s.data.name = u.display; s.data.role = u.job;
  s.join('user:' + u._id);
  for (const id of ['lobby', ...u.servers]) if (servers.has(id)) s.join('chat:' + id);
  s.emit('me', meInfo(u)); s.emit('servers', serverList(u));
  const srv = openServer(s, 'lobby');
  if (srv) s.emit('server:state', stateFor(s, srv));
  presenceFor(u);
}
function pushMe(u) { for (const x of socketsOf(u._id)) { x.data.name = u.display; x.data.role = u.job; x.emit('me', meInfo(u)); x.emit('servers', serverList(u)); } }
function dropFromServer(srv, uid, why) {
  delete srv.members[uid];
  const u = users.get(uid);
  if (u) { u.servers = u.servers.filter((x) => x !== srv._id); putUser(u); }
  putServer(srv);
  for (const x of socketsOf(uid)) {
    x.leave('chat:' + srv._id);
    if (x.data.srv === srv._id) toLobby(x);
    if (why !== null) x.emit('kicked', { server: srv._id, name: srv.name, why });
    if (u) x.emit('servers', serverList(u));
  }
  pushState(srv); presence(srv);
}
function deleteServer(srv) {
  for (const uid of Object.keys(srv.members)) {
    const u = users.get(uid);
    if (u) { u.servers = u.servers.filter((x) => x !== srv._id); putUser(u); }
    for (const x of socketsOf(uid)) {
      x.leave('chat:' + srv._id);
      if (x.data.srv === srv._id) toLobby(x);
      x.emit('kicked', { server: srv._id, name: srv.name, why: 'This server was deleted.' });
      if (u) x.emit('servers', serverList(u));
    }
  }
  for (const [id, g] of games) if (g.server === srv._id) games.delete(id);
  srv.invites.forEach((i) => inviteIdx.delete(i.code));
  for (const c of srv.channels) { chanMsgs(srv._id, c.id).forEach((m) => m.file && unlinkUrl(m.file.url)); delete msgs[chanKey(srv._id, c.id)]; }
  if (USE_MONGO) { col('msgs').deleteMany({ server: srv._id }).catch(logErr('server messages')); col('wsfiles').deleteMany({ server: srv._id }).catch(logErr('server files')); }
  srv.builds.forEach(deleteBuild);
  servers.delete(srv._id); dropDoc('servers', srv._id);
}

// ======================= chat, reports, moderation =======================
const BOT = { _id: null, display: 'Common Room', job: 'Bot', admin: false };
function makeMsg(u, srv, ch, text, file) {
  const m = { id: crypto.randomUUID(), server: srv._id, ch: ch.id, uid: u._id, name: u.display, role: u.job, adm: !!u.admin, text, time: now() };
  if (file) m.file = file;
  const arr = chanMsgs(srv._id, ch.id); arr.push(m); putMsg(m);
  while (arr.length > MAX_MESSAGES) { const old = arr.shift(); if (old.file) unlinkUrl(old.file.url); dropMsg(old); }
  io.to('chat:' + srv._id).emit('message', m);
  return m;
}
function postSystem(srv, text) { const ch = srv.channels.find((c) => c.name === 'dev') || srv.channels[0]; makeMsg(BOT, srv, ch, text); }
function canPost(u, srv) {
  if (!roleIn(srv, u._id)) return 'You are not in this server.';
  if (u.mutedUntil > now()) return 'You are muted for another ' + Math.ceil((u.mutedUntil - now()) / 60000) + ' min.';
  if (srv.muted[u._id] > now()) return 'You are muted here for another ' + Math.ceil((srv.muted[u._id] - now()) / 60000) + ' min.';
  if (!rate('msg:' + u._id, 8, 10000)) return 'Slow down a little.';
  return null;
}
function softDelete(m, by) {   // kept 7 days so reports still have evidence
  if (m.deleted) return;
  m.deleted = { by, time: now() }; putMsg(m);
  io.to('chat:' + m.server).emit('msg:deleted', { server: m.server, ch: m.ch, id: m.id });
}
const shortMsg = (m) => ({ id: m.id, uid: m.uid, name: m.name, text: (m.deleted ? '[deleted] ' : '') + m.text, time: m.time });
function snapChannel(sid, chId, upToId, n) {
  const arr = chanMsgs(sid, chId), end = upToId ? arr.findIndex((m) => m.id === upToId) + 1 : arr.length;
  return end === 0 ? [] : arr.slice(Math.max(0, end - n), end).map(shortMsg);
}
const threadId = (a, b) => [a, b].sort().join(':');
function getThread(a, b, create) {
  const id = threadId(a, b); let t = dms.get(id);
  if (!t && create) { const [x, y] = id.split(':'); t = { _id: id, a: x, b: y, msgs: [], read: {} }; dms.set(id, t); }
  return t;
}
const unreadOf = (t, uid) => t.msgs.filter((m) => m.from !== uid && m.time > (t.read[uid] || 0)).length;
function banUser(t, by, reason, alsoIp) {
  t.banned = { by: by ? by._id : null, reason: clip(reason, 200), time: now() }; putUser(t);
  for (const x of socketsOf(t._id)) {
    if (alsoIp && x.data.ip && !meta.banIps.includes(x.data.ip)) meta.banIps.push(x.data.ip);
    x.emit('banned', t.banned);
  }
  if (alsoIp) putMeta();
  log(by && by._id, alsoIp ? 'ban+ip' : 'ban', t._id, reason);
  setTimeout(() => socketsOf(t._id).forEach((x) => x.disconnect(true)), 300);
}

// ======================= uploads (chat attachments, workspace assets, builds) =======================
const lastPost = new Map();
setInterval(() => lastPost.clear(), 60000).unref();
// Rate limit, parse, and require a live signed-in socket from the same IP.
// keep() moves the uploaded temp file into permanent storage (GridFS in Mongo mode) and returns its URL.
function guarded(handler, uploader = upload) {
  return (req, res) => {
    const t = now(), ip = ipOf(req.headers, req.ip);
    if (t - (lastPost.get(ip) || 0) < 800) return res.status(429).json({ error: 'Slow down a little.' });
    lastPost.set(ip, t);
    uploader.single('file')(req, res, async (err) => {
      const drop = () => req.file && fs.unlink(req.file.path, () => {});
      const keep = async () => {
        if (USE_MONGO) {
          await new Promise((ok, bad) => fs.createReadStream(req.file.path).pipe(mongo.bucket.openUploadStream(req.file.filename)).on('finish', ok).on('error', bad));
          drop();
        }
        return '/uploads/' + req.file.filename;
      };
      try {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Files can be up to ${uploader === upload ? MAX_FILE_MB : MAX_BUILD_MB} MB.` : 'Upload failed.' });
        const s = io.sockets.sockets.get(String(req.body.sid || ''));
        const u = s && users.get(s.data.uid), srv = s && servers.get(s.data.srv);
        if (!s || s.data.ip !== ip || !u || u.banned || !srv || !roleIn(srv, u._id)) { drop(); return res.status(403).json({ error: 'Not connected.' }); }
        await handler(req, res, s, t, drop, keep, u, srv);
      } catch (e) { drop(); if (!res.headersSent) res.status(500).json({ error: 'Server error.' }); }
    });
  };
}
app.post('/api/post', guarded(async (req, res, s, t, drop, keep, u, srv) => {
  const ch = srv.channels.find((c) => c.id === String(req.body.ch));
  if (!ch) { drop(); return res.status(400).json({ error: 'Unknown channel.' }); }
  const bad = canPost(u, srv);
  if (bad) { drop(); return res.status(400).json({ error: bad }); }
  const text = clip(req.body.text, 2000);
  if (!text && !req.file) return res.status(400).json({ error: 'Write a message or attach a file.' });
  const file = req.file ? { url: await keep(), name: req.file.originalname.slice(0, 120), size: req.file.size, kind: kindOf(req.file.filename) } : null;
  makeMsg(u, srv, ch, text, file);
  res.json({ ok: true });
}));

// ======================= live docs (workspace text files are shared CRDT docs) =======================
const docs = new Map();   // 'server|file' -> { doc, timer }
const roomOf = (sid, name) => 'doc:' + sid + '|' + name;
function getDoc(srv, name) {
  const k = fkey(srv, name); let d = docs.get(k);
  if (!d) { d = { doc: Doc.fromText(srv.files[name].content || ''), timer: null }; docs.set(k, d); }
  return d;
}
function flush(srv, name) {
  const d = docs.get(fkey(srv, name)), f = srv.files[name];
  if (d) clearTimeout(d.timer);
  if (d && f && f.kind === 'text') { f.content = d.doc.text(); f.size = f.content.length; putFile(srv, name); }
}
function resetDoc(srv, name) { docs.delete(fkey(srv, name)); io.to(roomOf(srv._id, name)).emit('doc:reset', name); }
function leaveDoc(s) {
  const e = s.data.editing; if (!e) return;
  s.data.editing = null;
  s.to(roomOf(e.srv, e.name)).emit('doc:gone', s.id);
  s.data.cur = null; s.leave(roomOf(e.srv, e.name));
  const r = io.sockets.adapter.rooms.get(roomOf(e.srv, e.name)), srv = servers.get(e.srv);
  if (!r || !r.size) { if (srv) flush(srv, e.name); docs.delete(e.srv + '|' + e.name); }
  if (srv) pushFiles(srv);
}
function commit(s, srv, name, data, note, live) {
  let f = srv.files[name];
  if (!f) f = srv.files[name] = { name, v: 0, history: [] };
  const e = { v: ++f.v, by: s.data.name, role: s.data.role, time: now(), note: String(note || '').slice(0, 100), content: data.content, url: data.url, size: data.size };
  f.history.push(e);
  while (f.history.length > 15) {
    const o = f.history.shift();
    if (o.url && o.url !== data.url && !f.history.some((h) => h.url === o.url)) unlinkUrl(o.url);
  }
  Object.assign(f, { kind: data.url ? 'bin' : 'text', by: e.by, role: e.role, time: e.time, content: data.content, url: data.url, size: data.size != null ? data.size : (data.content || '').length });
  if (!live && docs.has(fkey(srv, name))) resetDoc(srv, name);
  putFile(srv, name); pushFiles(srv);
  io.to('srv:' + srv._id).emit('ws:updated', { name, v: f.v, by: e.by });
  return f.v;
}
app.post('/api/asset', guarded(async (req, res, s, t, drop, keep, u, srv) => {
  if (!req.file) return res.status(400).json({ error: 'No file.' });
  const name = validName(req.body.name) ? req.body.name : safeUrlName(req.file.originalname);
  if (!srv.files[name] && Object.keys(srv.files).length >= MAX_FILES) { drop(); return res.status(400).json({ error: 'Workspace is full.' }); }
  if (TEXT_EXT.test(name)) { const content = fs.readFileSync(req.file.path, 'utf8'); drop(); commit(s, srv, name, { content }, req.body.note); }
  else commit(s, srv, name, { url: await keep(), size: req.file.size }, req.body.note);
  res.json({ ok: true });
}));

// Play a build: /play/<id>/ serves the unzipped export. By default builds run sandboxed (opaque origin, no access to
// this site's storage). Set BUILD_SANDBOX=0 for threaded Godot builds that need cross-origin isolation (trusted use only).
app.get('/play/:id', (req, res, next) => {
  if (req.path.endsWith('/')) return next();
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
app.post('/api/build', guarded(async (req, res, s, t, drop, keep, u, srv) => {
  try {
    if (!req.file) throw new Error('No file.');
    if (!/\.zip$/i.test(req.file.originalname)) throw new Error('Upload a .zip of your web export.');
    const label = clip(req.body.name, 60) || req.file.originalname.replace(/\.zip$/i, '').slice(0, 60);
    const b = await importBuild(req.file.path, label, s);
    srv.builds.unshift(b);
    while (srv.builds.length > 10) deleteBuild(srv.builds.pop());
    putServer(srv); pushBuilds(srv);
    postSystem(srv, `🎮 ${u.display} uploaded a playable build "${b.name}": ${req.protocol}://${req.get('host')}/play/${b.id}/`);
    res.json({ ok: true, id: b.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
  finally { drop(); }
}, uploadBuild));

// ======================= one person per IP (plus banned IPs) =======================
const ipSocket = new Map();
io.use((s, next) => {
  const ip = ipOf(s.handshake.headers, s.handshake.address);
  if (meta.banIps.includes(ip)) return next(new Error('banned'));
  const tok = String((s.handshake.auth && s.handshake.auth.tok) || '').slice(0, 64);
  if (tok.length < 12) return next(new Error('bad-token'));
  const th = sha(tok), cur = ipSocket.get(ip);
  if (cur) {
    const old = io.sockets.sockets.get(cur.id);
    if (old && cur.th !== th) return next(new Error('ip-busy'));   // a different browser holds this IP
    if (old) old.disconnect(true);                                // same browser (refresh / 2nd tab): replace the old connection
  }
  s.data.ip = ip; s.data.th = th; s.data.uid = byToken.get(th) || null;
  s.data.name = 'Guest'; s.data.role = 'Other';
  ipSocket.set(ip, { id: s.id, th });
  next();
});

// ======================= games =======================
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
const reset = (g) => {
  g.board = Array(g.type === 'c4' ? 42 : 9).fill('');
  g.turn = g.type === 'c4' ? 'R' : 'X';
  g.picks = {}; g.shown = null; g.winner = null; g.status = g.guest ? 'playing' : 'waiting';
  g.hc = null; g.hf = null;   // the toss happens only once both players are in
  if (g.guest && g.type === 'hf') hfInit(g);
  if (g.guest && g.type === 'hc') g.hc = { batter: Math.random() < 0.5 ? 'host' : 'guest', innings: 1, scores: { host: 0, guest: 0 }, target: null, last: null, log: [] };
};

const serverGames = (sid) => [...games.values()].filter((g) => g.server === sid);
const pushGames = (sid) => io.to('srv:' + sid).emit('games', serverGames(sid).map(pub));
const leaveGames = (sid) => {
  const touched = new Set();
  for (const [id, g] of games) if (g.host.sid === sid || (g.guest && g.guest.sid === sid)) { games.delete(id); touched.add(g.server); }
  touched.forEach((x) => pushGames(x));
};
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



// ======================= socket events =======================
io.on('connection', (s) => {
  const on = (ev, fn) => s.on(ev, (...a) => { try { const r = fn(...a); if (r && r.catch) r.catch((e) => console.error(ev, e.message)); } catch (e) { console.error(ev, e.message); } });
  const split = (a) => [typeof a[0] === 'function' ? undefined : a[0], typeof a[a.length - 1] === 'function' ? a[a.length - 1] : () => {}];
  const auth = (ev, fn) => on(ev, (...a) => {
    const [p, cb] = split(a), u = users.get(s.data.uid);
    if (!u || u.banned) return cb({ error: 'Not signed in.' });
    return fn(u, p, cb);
  });
  const inSrv = (ev, fn) => auth(ev, (u, p, cb) => {
    const srv = servers.get(s.data.srv);
    if (!srv || !roleIn(srv, u._id)) return cb({ error: 'Open a server first.' });
    return fn(u, srv, p, cb);
  });
  const adm = (ev, fn) => auth(ev, (u, p, cb) => (u.admin ? fn(u, p, cb) : cb({ error: 'Admins only.' })));
  const need = (srv, u, min) => rankIn(srv, u._id) >= RANK[min];
  const pushServersTo = (srv) => { for (const uid of Object.keys(srv.members)) { const x = users.get(uid); if (x) socketsOf(uid).forEach((so) => so.emit('servers', serverList(x))); } };
  const target = (srv, u, uid, cb) => {   // a moderation target must be a member of lower rank
    const t = users.get(uid);
    if (!t || t._id === u._id || !roleIn(srv, t._id)) { cb({ error: 'Not a member.' }); return null; }
    if (rankIn(srv, t._id) >= rankIn(srv, u._id)) { cb({ error: 'You can only act on people ranked below you.' }); return null; }
    return t;
  };

  // ---------- accounts ----------
  on('account:register', (...a) => {
    const [p, cb] = split(a);
    if (s.data.uid) return cb({ error: 'Already signed in.' });
    const r = register(s, p || {});
    if (r.error) return cb(r);
    login(s, r.u); cb({ ok: true, code: r.code });
  });
  on('account:recover', (...a) => {
    const [p, cb] = split(a);
    if (s.data.uid) return cb({ error: 'Already signed in.' });
    const r = recover(s, p || {});
    if (r.error) return cb(r);
    login(s, r.u); cb({ ok: true });
  });
  auth('account:newcode', (u, p, cb) => {
    if (!rate('newcode:' + u._id, 5, 3600e3)) return cb({ error: 'Too many requests.' });
    const code = newRecoveryCode(); u.recovery = codeHash(code); putUser(u); log(u._id, 'new-recovery-code'); cb({ ok: true, code });
  });
  auth('me:update', (u, p, cb) => {
    p = p || {};
    if (p.display !== undefined) {
      const d = clip(p.display, 24);
      if (!d) return cb({ error: "Display name can't be empty." });
      if (d !== u.display) {
        if (u.nameChanged && now() - u.nameChanged < 600e3) return cb({ error: 'You can change your display name once every 10 minutes.' });
        u.display = d; u.nameChanged = now(); u.nameHistory.push({ name: d, time: now() });
        if (u.nameHistory.length > 20) u.nameHistory.shift();
      }
    }
    if (p.bio !== undefined) u.bio = clip(p.bio, 150);
    if (p.status !== undefined) u.status = clip(p.status, 60);
    if (p.job !== undefined && JOBS.includes(p.job)) u.job = p.job;
    if (p.avatar !== undefined) {
      const av = cleanAvatar(p.avatar);
      if (!av) return cb({ error: 'That picture is not allowed (max about 30 KB).' });
      if (av.t === 'img' && !rate('avatar:' + u._id, 6, 3600e3)) return cb({ error: 'Too many picture changes. Try later.' });
      u.avatar = av;
    }
    putUser(u); io.emit('card', card(u)); pushMe(u); cb({ ok: true });
  });
  auth('users:get', (u, p, cb) => cb({ cards: (Array.isArray(p) ? p : []).slice(0, 60).map((id) => users.get(id)).filter(Boolean).map(card) }));
  auth('users:find', (u, p, cb) => {
    const q = clip(p, 20).toLowerCase(), out = [];
    if (q.length >= 2) for (const [n, id] of byName) { const x = users.get(id); if (n.startsWith(q) && x && !x.banned && id !== u._id) { out.push(card(x)); if (out.length >= 8) break; } }
    cb({ cards: out });
  });
  auth('user:block', (u, p, cb) => {
    if (!users.has(p && p.uid) || p.uid === u._id) return cb({ error: 'Not found.' });
    u.blocked = u.blocked.filter((x) => x !== p.uid); if (p.block) u.blocked.push(p.uid);
    putUser(u); pushMe(u); cb({ ok: true });
  });
  auth('me:dmoff', (u, p, cb) => { u.dmOff = !!(p && p.off); putUser(u); pushMe(u); cb({ ok: true }); });
  auth('admin:login', (u, p, cb) => {
    if (!ADMIN_KEY) return cb({ error: 'No admin key is set on the server (ADMIN_KEY).' });
    if (!rate('adminkey:' + s.data.ip, 5, 600e3)) return cb({ error: 'Too many attempts.' });
    if (!safeEq(String(p && p.key), ADMIN_KEY)) return cb({ error: 'Wrong admin key.' });
    u.admin = true; putUser(u); log(u._id, 'admin-login'); io.emit('card', card(u)); pushMe(u); cb({ ok: true });
  });

  // ---------- servers ----------
  auth('server:open', (u, p, cb) => { const srv = openServer(s, p && p.id); if (!srv) return cb({ error: 'Server not found.' }); cb({ ok: true, state: stateFor(s, srv) }); });
  auth('server:create', (u, p, cb) => {
    const name = clip(p && p.name, 30);
    if (name.length < 2) return cb({ error: 'Server name must be 2-30 characters.' });
    if ([...servers.values()].filter((x) => x.owner === u._id).length >= LIM.owned) return cb({ error: `You can own up to ${LIM.owned} servers.` });
    if (!rate('mksrv:' + u._id, 5, 3600e3)) return cb({ error: 'Too many servers created. Try later.' });
    const srv = newServer(rid(5), name, u._id, false);
    servers.set(srv._id, srv); u.servers.push(srv._id); putServer(srv); putUser(u);
    for (const x of socketsOf(u._id)) { x.join('chat:' + srv._id); x.emit('servers', serverList(u)); }
    cb({ ok: true, id: srv._id });
  });
  auth('server:join', (u, p, cb) => {
    if (!rate('join:' + u._id, 15, 600e3)) return cb({ error: 'Too many attempts.' });
    const code = clip(p && p.code, 24).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const srv = servers.get(inviteIdx.get(code)), inv = srv && srv.invites.find((i) => i.code === code);
    if (!inv || inv.revoked || (inv.expires && inv.expires < now()) || (inv.max && inv.uses >= inv.max)) return cb({ error: 'That invite is invalid or expired.' });
    if (srv.banned[u._id]) return cb({ error: "You can't join this server." });
    if (srv.members[u._id]) return cb({ ok: true, id: srv._id });
    if (Object.keys(srv.members).length >= LIM.members) return cb({ error: 'This server is full.' });
    if (u.servers.length >= LIM.joined) return cb({ error: 'You have joined too many servers.' });
    srv.members[u._id] = 'member'; inv.uses++; u.servers.push(srv._id); putServer(srv); putUser(u);
    for (const x of socketsOf(u._id)) { x.join('chat:' + srv._id); x.emit('servers', serverList(u)); }
    pushState(srv); presence(srv);
    cb({ ok: true, id: srv._id });
  });
  auth('server:leave', (u, p, cb) => {
    const srv = servers.get(p && p.id);
    if (!srv || srv.lobby || !srv.members[u._id]) return cb({ error: "You can't leave that." });
    if (srv.owner === u._id) return cb({ error: 'Owners can delete the server instead.' });
    dropFromServer(srv, u._id, null); cb({ ok: true });
  });
  auth('server:delete', (u, p, cb) => {
    const srv = servers.get(p && p.id);
    if (!srv || srv.lobby || srv.owner !== u._id) return cb({ error: 'Only the owner can delete a server.' });
    log(u._id, 'delete-server', srv._id, srv.name); deleteServer(srv); cb({ ok: true });
  });
  inSrv('server:rename', (u, srv, p, cb) => {
    if (!need(srv, u, 'admin')) return cb({ error: 'Admins only.' });
    const name = clip(p && p.name, 30); if (name.length < 2) return cb({ error: 'Name must be 2-30 characters.' });
    srv.name = name; putServer(srv); pushState(srv); pushServersTo(srv); cb({ ok: true });
  });
  inSrv('channel:add', (u, srv, p, cb) => {
    if (!need(srv, u, 'admin')) return cb({ error: 'Admins only.' });
    if (srv.channels.length >= LIM.channels) return cb({ error: `Up to ${LIM.channels} channels.` });
    const name = clip(p && p.name, 20).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) return cb({ error: 'Pick a channel name (letters, numbers, dashes).' });
    if (srv.channels.some((c) => c.name === name)) return cb({ error: 'That channel already exists.' });
    srv.channels.push({ id: srv.lobby ? name : rid(3), name }); putServer(srv); pushState(srv); cb({ ok: true });
  });
  inSrv('channel:del', (u, srv, p, cb) => {
    if (!need(srv, u, 'admin')) return cb({ error: 'Admins only.' });
    if (srv.channels.length <= 1) return cb({ error: "You can't delete the last channel." });
    const c = srv.channels.find((x) => x.id === (p && p.id)); if (!c) return cb({ error: 'No such channel.' });
    srv.channels = srv.channels.filter((x) => x !== c);
    chanMsgs(srv._id, c.id).forEach((m) => m.file && unlinkUrl(m.file.url)); delete msgs[chanKey(srv._id, c.id)];
    if (USE_MONGO) col('msgs').deleteMany({ server: srv._id, ch: c.id }).catch(logErr('channel messages'));
    putServer(srv); dirty(); pushState(srv); cb({ ok: true });
  });
  inSrv('invite:create', (u, srv, p, cb) => {
    if (srv.lobby) return cb({ error: 'The lobby is open to everyone.' });
    if (!need(srv, u, 'admin')) return cb({ error: 'Only admins can create invites.' });
    if (srv.invites.length >= LIM.invites) return cb({ error: 'Too many active invites. Revoke one first.' });
    const hours = Math.min(Math.max(Number(p && p.hours) || 0, 0), 24 * 30), max = Math.min(Math.max(Number(p && p.max) || 0, 0), 1000);
    const inv = { code: randCode(8), by: u._id, created: now(), expires: hours ? now() + hours * 3600e3 : 0, max, uses: 0, revoked: false };
    srv.invites.push(inv); inviteIdx.set(inv.code, srv._id); putServer(srv); pushState(srv); cb({ ok: true, code: inv.code });
  });
  inSrv('invite:revoke', (u, srv, p, cb) => {
    if (!need(srv, u, 'admin')) return cb({ error: 'Admins only.' });
    srv.invites = srv.invites.filter((i) => i.code !== (p && p.code)); inviteIdx.delete(p && p.code);
    putServer(srv); pushState(srv); cb({ ok: true });
  });
  inSrv('role:set', (u, srv, p, cb) => {
    if (!need(srv, u, 'owner')) return cb({ error: 'Only the owner can change roles.' });
    const t = users.get(p && p.uid);
    if (!t || t._id === u._id || (!srv.lobby && !srv.members[t._id]) || (srv.lobby && t.admin)) return cb({ error: "You can't change that person's role." });
    if (!['admin', 'mod', 'member'].includes(p.role)) return cb({ error: 'Bad role.' });
    if (srv.lobby && p.role === 'member') delete srv.members[t._id]; else srv.members[t._id] = p.role;
    log(u._id, 'role', t._id, srv._id + ':' + p.role); putServer(srv); pushState(srv); cb({ ok: true });
  });
  inSrv('mod:mute', (u, srv, p, cb) => {
    if (!need(srv, u, 'mod')) return cb({ error: 'Moderators only.' });
    const t = target(srv, u, p && p.uid, cb); if (!t) return;
    const min = Math.min(Math.max(Number(p.minutes) || 0, 0), 7 * 1440);
    if (min) srv.muted[t._id] = now() + min * 60000; else delete srv.muted[t._id];
    log(u._id, 'mute', t._id, srv._id + ':' + min); putServer(srv);
    socketsOf(t._id).forEach((x) => x.emit('notice', { text: min ? `You were muted for ${min} min in ${srv.name}.` : `You were unmuted in ${srv.name}.` }));
    cb({ ok: true });
  });
  inSrv('mod:kick', (u, srv, p, cb) => {
    if (srv.lobby) return cb({ error: 'Nobody can be kicked from the lobby. Use mute (or ask an admin to ban).' });
    if (!need(srv, u, 'mod')) return cb({ error: 'Moderators only.' });
    const t = target(srv, u, p && p.uid, cb); if (!t) return;
    log(u._id, 'kick', t._id, srv._id); dropFromServer(srv, t._id, 'You were removed from this server.'); cb({ ok: true });
  });
  inSrv('mod:ban', (u, srv, p, cb) => {
    if (srv.lobby) return cb({ error: 'Only site admins can ban from the lobby.' });
    if (!need(srv, u, 'admin')) return cb({ error: 'Admins only.' });
    const t = target(srv, u, p && p.uid, cb); if (!t) return;
    srv.banned[t._id] = true; log(u._id, 'server-ban', t._id, srv._id); dropFromServer(srv, t._id, 'You were banned from this server.'); cb({ ok: true });
  });
  inSrv('mod:unban', (u, srv, p, cb) => {
    if (!need(srv, u, 'admin')) return cb({ error: 'Admins only.' });
    delete srv.banned[p && p.uid]; putServer(srv); pushState(srv); cb({ ok: true });
  });

  // ---------- chat ----------
  inSrv('chat:history', (u, srv, p, cb) => {
    const ch = srv.channels.find((c) => c.id === (p && p.ch));
    if (!ch) return cb({ error: 'No such channel.' });
    cb({ ok: true, server: srv._id, ch: ch.id, msgs: chanMsgs(srv._id, ch.id).filter((m) => !m.deleted) });
  });
  inSrv('chat:send', (u, srv, p, cb) => {
    const ch = srv.channels.find((c) => c.id === (p && p.ch)), text = clip(p && p.text, 2000);
    if (!ch || !text) return cb({ error: 'Write a message first.' });
    const bad = canPost(u, srv); if (bad) return cb({ error: bad });
    makeMsg(u, srv, ch, text); cb({ ok: true });
  });
  inSrv('msg:delete', (u, srv, p, cb) => {
    const m = chanMsgs(srv._id, p && p.ch).find((x) => x.id === (p && p.id));
    if (!m) return cb({ error: 'Message not found.' });
    if (m.uid !== u._id && !need(srv, u, 'mod')) return cb({ error: 'You can only delete your own messages.' });
    if (m.uid !== u._id) log(u._id, 'delete-message', m.uid, srv._id + ':' + m.id);
    softDelete(m, u._id); cb({ ok: true });
  });

  // ---------- reports ----------
  auth('report:send', (u, p, cb) => {
    p = p || {};
    if (!rate('report:' + u._id, 10, 3600e3)) return cb({ error: 'Too many reports. Try again later.' });
    const r = { _id: rid(6), type: p.type, reporter: u._id, reason: clip(p.reason, 300), time: now(), status: 'open', snapshot: [] };
    if (p.type === 'message') {
      const srv = servers.get(p.server), m = srv && roleIn(srv, u._id) && chanMsgs(srv._id, p.ch).find((x) => x.id === p.id);
      if (!m) return cb({ error: 'Message not found.' });
      Object.assign(r, { server: srv._id, ch: p.ch, msgId: m.id, target: m.uid, snapshot: snapChannel(srv._id, p.ch, m.id, 11) });
    } else if (p.type === 'user') {
      const t = users.get(p.uid); if (!t) return cb({ error: 'User not found.' });
      r.target = t._id;
    } else if (p.type === 'server') {
      const srv = servers.get(p.server); if (!srv || !roleIn(srv, u._id)) return cb({ error: 'Server not found.' });
      r.server = srv._id; r.target = srv.owner;
      r.snapshot = srv.channels.flatMap((c) => snapChannel(srv._id, c.id, null, 20)).sort((a, b) => a.time - b.time).slice(-40);
    } else if (p.type === 'dm') {
      const t = users.get(p.uid), th = t && getThread(u._id, t._id, false); if (!th) return cb({ error: 'Conversation not found.' });
      r.target = t._id; r.snapshot = th.msgs.slice(-20).map((m) => ({ id: m.id, uid: m.from, name: users.get(m.from) ? users.get(m.from).display : '?', text: m.text, time: m.time }));
    } else return cb({ error: 'Unknown report type.' });
    if (r.target === u._id) return cb({ error: "You can't report yourself." });
    if (reports.some((x) => x.reporter === u._id && x.type === r.type && x.target === r.target && x.server === r.server && now() - x.time < 3600e3)) return cb({ ok: true });
    reports.unshift(r); if (reports.length > 500) reports.pop();
    putReport(r); cb({ ok: true });
  });

  // ---------- direct messages ----------
  auth('dm:threads', (u, p, cb) => {
    const out = [];
    for (const t of dms.values()) {
      if (t.a !== u._id && t.b !== u._id) continue;
      const other = t.a === u._id ? t.b : t.a, last = t.msgs[t.msgs.length - 1];
      if (last && users.get(other)) out.push({ uid: other, card: card(users.get(other)), last, unread: unreadOf(t, u._id) });
    }
    out.sort((a, b) => b.last.time - a.last.time); cb({ ok: true, threads: out });
  });
  auth('dm:open', (u, p, cb) => {
    const t = users.get(p && p.uid); if (!t) return cb({ error: 'User not found.' });
    const th = getThread(u._id, t._id, false);
    if (th) { th.read[u._id] = now(); put('dms', th); }
    cb({ ok: true, card: card(t), msgs: th ? th.msgs.slice(-100) : [], blocked: u.blocked.includes(t._id) });
  });
  auth('dm:read', (u, p) => { const th = getThread(u._id, (p && p.uid) || '', false); if (th) { th.read[u._id] = now(); put('dms', th); } });
  auth('dm:send', (u, p, cb) => {
    const t = users.get(p && p.to), text = clip(p && p.text, 1000);
    if (!t || t._id === u._id || t.banned) return cb({ error: "You can't message this user." });
    if (!text) return cb({ error: 'Write a message first.' });
    if (u.mutedUntil > now()) return cb({ error: 'You are muted right now.' });
    if (now() - u.created < DM_MIN_AGE) return cb({ error: 'New accounts can send DMs after 2 minutes.' });
    if (t.dmOff || t.blocked.includes(u._id)) return cb({ error: "You can't message this user." });
    if (u.blocked.includes(t._id)) return cb({ error: 'You blocked this user. Unblock them first.' });
    if (!rate('dm:' + u._id, 15, 60000)) return cb({ error: 'Slow down a little.' });
    const th = getThread(u._id, t._id, true), m = { id: crypto.randomUUID(), from: u._id, text, time: now() };
    th.msgs.push(m); if (th.msgs.length > 200) th.msgs.shift();
    th.read[u._id] = m.time; put('dms', th);
    socketsOf(t._id).forEach((x) => x.emit('dm', { with: u._id, from: u._id, msg: m }));
    socketsOf(u._id).forEach((x) => x.emit('dm', { with: t._id, from: u._id, msg: m }));
    cb({ ok: true });
  });

  // ---------- site admin ----------
  const enrich = (r) => ({ ...r, reporterName: users.get(r.reporter) ? users.get(r.reporter).username : '?', targetCard: users.get(r.target) ? card(users.get(r.target)) : null,
    serverName: r.server && servers.get(r.server) ? servers.get(r.server).name : null });
  adm('admin:reports', (u, p, cb) => {
    const st = (p && p.status) || 'open';
    cb({ ok: true, reports: reports.filter((r) => st === 'all' || r.status === st).slice(0, 100).map(enrich) });
  });
  adm('admin:act', (u, p, cb) => {
    const r = reports.find((x) => x._id === (p && p.id)); if (!r) return cb({ error: 'Report not found.' });
    const a = p.action, t = users.get(r.target);
    if (a === 'mute') { if (!t) return cb({ error: 'User not found.' }); t.mutedUntil = now() + 86400e3; putUser(t); pushMe(t); }
    else if (a === 'ban' || a === 'banip') { if (!t || t.admin) return cb({ error: "Can't ban that user." }); banUser(t, u, r.reason, a === 'banip'); }
    else if (a === 'delmsg') { const m = r.msgId && chanMsgs(r.server, r.ch).find((x) => x.id === r.msgId); if (m) softDelete(m, u._id); }
    else if (a === 'delserver') { const srv = servers.get(r.server); if (srv && !srv.lobby) { log(u._id, 'delete-server', srv._id, srv.name); deleteServer(srv); } }
    else if (a !== 'dismiss') return cb({ error: 'Unknown action.' });
    r.status = a === 'dismiss' ? 'dismissed' : 'actioned'; r.action = a; r.handledBy = u._id; r.handledAt = now(); putReport(r);
    log(u._id, 'report-' + a, r.target, r._id); cb({ ok: true });
  });
  adm('admin:serverReview', (u, p, cb) => {   // read-only look inside a server, only if it has an open report about the server
    const srv = servers.get(p && p.id);
    if (!srv || !reports.some((r) => r.type === 'server' && r.server === srv._id && r.status === 'open')) return cb({ error: 'Only reported servers can be reviewed.' });
    log(u._id, 'review-server', srv._id, srv.name);
    const o = users.get(srv.owner);
    cb({ ok: true, name: srv.name, owner: o ? card(o) : null, members: Object.keys(srv.members).length,
      channels: srv.channels.map((c) => ({ name: c.name, msgs: chanMsgs(srv._id, c.id).slice(-100).map(shortMsg) })) });
  });
  adm('admin:users', (u, p, cb) => {
    const q = clip(p && p.q, 20).toLowerCase(), out = [];
    for (const x of users.values()) if ((q === 'banned' ? x.banned : x.username.toLowerCase().startsWith(q)) && out.length < 20) out.push({ ...card(x), banned: x.banned, mutedUntil: x.mutedUntil, nameHistory: x.nameHistory.slice(-5) });
    cb({ ok: true, users: out });
  });
  adm('admin:ban', (u, p, cb) => {
    const t = users.get(p && p.uid); if (!t || t.admin) return cb({ error: "Can't ban that user." });
    banUser(t, u, p.reason || 'Banned by an admin', !!p.ip); cb({ ok: true });
  });
  adm('admin:unban', (u, p, cb) => {
    const t = users.get(p && p.uid); if (!t) return cb({ error: 'User not found.' });
    t.banned = null; t.mutedUntil = 0; putUser(t); log(u._id, 'unban', t._id); cb({ ok: true });
  });
  adm('admin:clearips', (u, p, cb) => { meta.banIps = []; putMeta(); log(u._id, 'clear-ip-bans'); cb({ ok: true }); });
  adm('admin:audit', (u, p, cb) => cb({ ok: true, entries: audit.slice(-100).reverse().map((e) => ({ ...e, byName: users.get(e.by) ? users.get(e.by).username : '', targetName: users.get(e.target) ? users.get(e.target).username : '' })) }));

  // ---------- games ----------
  inSrv('game:create', (u, srv, type) => {
    if (!ROLES_OF[type] && type !== 'rps' && type !== 'hc' && type !== 'hf') return;
    if (inGame(s.id)) return;
    const g = { id: rid(4), server: srv._id, type, host: { sid: s.id, name: u.display }, guest: null };
    reset(g); games.set(g.id, g); pushGames(srv._id);
  });
  inSrv('game:join', (u, srv, id) => {
    const g = games.get(id);
    if (!g || g.server !== srv._id || g.guest || inGame(s.id)) return;
    g.guest = { sid: s.id, name: u.display };
    reset(g);   // fresh game state, and any toss happens now that both players are here
    pushGames(srv._id);
  });
  inSrv('game:move', (u, srv, p) => {
    const { id, v } = p;
    const g = games.get(id);
    if (!g || g.server !== srv._id || g.status !== 'playing') return;
    const isHost = g.host.sid === s.id;
    if (!isHost && !(g.guest && g.guest.sid === s.id)) return;
    if (g.type === 'hc') { hcMove(g, s.id, v); pushGames(srv._id); return; }
    if (g.type === 'hf') { hfMove(g, s.id, v); pushGames(srv._id); return; }
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
    pushGames(srv._id);
  });
  inSrv('game:rematch', (u, srv, id) => {
    const g = games.get(id);
    if (g && g.server === srv._id && g.status === 'done' && (g.host.sid === s.id || g.guest.sid === s.id)) { reset(g); pushGames(srv._id); }
  });
  inSrv('game:leave', () => { leaveGames(s.id); });

  // ---------- voice (WebRTC signaling only; audio goes peer to peer) ----------
  inSrv('voice:join', (u, srv, p, cb) => { s.data.voice = srv._id; cb(voiceList(srv._id).filter((x) => x.id !== s.id)); pushVoice(srv._id); });
  inSrv('voice:leave', (u, srv) => { s.data.voice = null; pushVoice(srv._id); });
  inSrv('voice:signal', (u, srv, p) => {
    const t = io.sockets.sockets.get(p.to);
    if (t && s.data.voice === srv._id && t.data.voice === srv._id) t.emit('voice:signal', { from: s.id, data: p.data });
  });

  // ---------- workspace: files (live docs), tasks, builds ----------
  const hist = (f) => f.history.map(({ v, by, role, time, note }) => ({ v, by, role, time, note })).reverse();
  inSrv('ws:open', (u, srv, name, cb) => {
    const f = srv.files[name];
    if (!f) return cb({ error: 'missing' });
    leaveDoc(s);
    const res = { kind: f.kind, v: f.v, url: f.url, size: f.size, history: hist(f) };
    if (f.kind === 'text') {
      s.data.editing = { srv: srv._id, name }; s.join(roomOf(srv._id, name));
      res.runs = getDoc(srv, name).doc.dump(); res.cursors = [];
      for (const id of io.sockets.adapter.rooms.get(roomOf(srv._id, name)) || []) {
        const o = io.sockets.sockets.get(id);
        if (o && o !== s && o.data.cur) res.cursors.push({ id, user: o.data.name, a: o.data.cur.a, b: o.data.cur.b });
      }
    }
    pushFiles(srv); cb(res);
  });
  inSrv('ws:close', (u, srv) => { leaveDoc(s); pushFiles(srv); });
  inSrv('ws:hist', (u, srv, name, cb) => { const f = srv.files[name]; if (f) cb({ v: f.v, history: hist(f) }); });
  inSrv('ws:create', (u, srv, name, cb) => {
    if (!validName(name) || srv.files[name] || Object.keys(srv.files).length >= MAX_FILES) return cb({ error: 'Bad name, duplicate, or workspace full.' });
    commit(s, srv, name, { content: '' }, 'created'); cb({ ok: true });
  });
  inSrv('doc:ops', (u, srv, p) => {
    const e = s.data.editing;
    if (!e || e.srv !== srv._id || p.name !== e.name || !Array.isArray(p.ops) || p.ops.length > 100000) return;
    const d = getDoc(srv, e.name), applied = [];
    for (const op of p.ops) if (d.doc.apply(op)) applied.push(op);
    if (!applied.length) return;
    s.to(roomOf(srv._id, e.name)).emit('doc:ops', { name: e.name, ops: applied });
    clearTimeout(d.timer); d.timer = setTimeout(() => flush(srv, e.name), 1500);
  });
  inSrv('doc:cursor', (u, srv, p) => {
    const e = s.data.editing, ok = (k) => typeof k === 'string' && (k === '' || /^\d{1,9}\.[a-z0-9]{1,8}$/.test(k));
    if (!e || p.name !== e.name || !ok(p.a) || !ok(p.b)) return;
    s.data.cur = { a: p.a, b: p.b };
    s.to(roomOf(srv._id, e.name)).emit('doc:cursor', { id: s.id, user: s.data.name, a: p.a, b: p.b });
  });
  inSrv('ws:save', (u, srv, p, cb) => {
    const f = srv.files[p.name]; if (!f || f.kind !== 'text') return cb({ error: 'Cannot save.' });
    const d = docs.get(fkey(srv, p.name));
    cb({ ok: true, v: commit(s, srv, p.name, { content: d ? d.doc.text() : f.content }, p.note, true) });
  });
  inSrv('ws:restore', (u, srv, p, cb) => {
    const f = srv.files[p.name], h = f && f.history.find((x) => x.v === p.v);
    if (!h || h.content === undefined) return cb({ error: 'Cannot restore that version.' });
    cb({ ok: true, v: commit(s, srv, p.name, { content: h.content }, 'restored v' + p.v) });
  });
  inSrv('ws:delete', (u, srv, name, cb) => {
    const f = srv.files[name]; if (!f) return;
    if (!need(srv, u, 'mod')) return cb({ error: 'Only moderators can delete files.' });
    f.history.forEach((h) => h.url && unlinkUrl(h.url));
    io.to(roomOf(srv._id, name)).emit('doc:reset', name); docs.delete(fkey(srv, name));
    delete srv.files[name]; dropFile(srv, name); pushFiles(srv); cb({ ok: true });
  });
  inSrv('build:del', (u, srv, id, cb) => {
    if (!need(srv, u, 'mod')) return cb({ error: 'Only moderators can delete builds.' });
    const i = srv.builds.findIndex((b) => b.id === id); if (i < 0) return;
    deleteBuild(srv.builds.splice(i, 1)[0]); putServer(srv); pushBuilds(srv); cb({ ok: true });
  });
  const task = (srv, id) => srv.tasks.find((t) => t.id === id);
  inSrv('task:add', (u, srv, p) => {
    const title = clip(p.title, 120); if (!title || srv.tasks.length >= 300) return;
    srv.tasks.push({ id: crypto.randomUUID(), title, type: ['Bug', 'Task', 'Asset'].includes(p.type) ? p.type : 'Task', status: 'todo', by: u.display, assignee: null });
    putServer(srv); pushTasks(srv);
  });
  inSrv('task:move', (u, srv, p) => {
    const t = task(srv, p.id); if (!t || !['todo', 'doing', 'done'].includes(p.status)) return;
    t.status = p.status; if (p.status === 'doing' && !t.assignee) t.assignee = u.display;
    putServer(srv); pushTasks(srv);
  });
  inSrv('task:claim', (u, srv, id) => { const t = task(srv, id); if (t) { t.assignee = t.assignee === u.display ? null : u.display; putServer(srv); pushTasks(srv); } });
  inSrv('task:del', (u, srv, id) => { srv.tasks = srv.tasks.filter((t) => t.id !== id); putServer(srv); pushTasks(srv); });

  // ---------- connection lifecycle ----------
  const u0 = users.get(s.data.uid);
  if (u0) { if (u0.banned) s.emit('banned', u0.banned); else login(s, u0); } else s.emit('need-account');

  s.on('disconnect', () => {
    if ((ipSocket.get(s.data.ip) || {}).id === s.id) ipSocket.delete(s.data.ip);
    leaveActive(s);
    const u = users.get(s.data.uid);
    if (u && !isOnline(u._id)) presenceFor(u);
  });
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const k of [...docs.keys()]) { const i = k.indexOf('|'), srv = servers.get(k.slice(0, i)); if (srv) flush(srv, k.slice(i + 1)); }
  if (USE_MONGO) await flushAll(); else saveDisk();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

init()
  .then(() => {
    server.listen(PORT, () => console.log('Common Room running on port ' + PORT + (USE_MONGO ? ' (MongoDB)' : ' (local disk)')));
    require('./bots').start({ io, users, byName, servers, chanMsgs, makeMsg, putUser, rate, rid, sha, now });
  })
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });