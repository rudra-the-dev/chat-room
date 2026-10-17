const $ = (id) => document.getElementById(id);
function h(tag, a, ...kids) {   // tiny DOM builder: h('div', 'class', {props}, ...children)
  const e = document.createElement(tag);
  let props = null;
  if (typeof a === 'string') { if (kids.length === 0) e.textContent = a; else e.className = a; }   // h('b','text') or h('div','class',...children)
  else if (a && !(a instanceof Node)) props = a; else if (a != null) kids.unshift(a);
  const k0 = kids[0];
  if (k0 && typeof k0 === 'object' && !(k0 instanceof Node) && !Array.isArray(k0)) props = Object.assign(props || {}, kids.shift());
  if (props) { const { dataset, style, ...rest } = props; Object.assign(e, rest); if (dataset) Object.assign(e.dataset, dataset); if (style) e.style.cssText = style; }
  kids.flat().forEach((k) => { if (k != null && k !== false) e.append(k); });
  return e;
}
function el(tag, text, cls) { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; }
function btn(text, fn, disabled) { const b = el('button', text); b.type = 'button'; b.onclick = fn; b.disabled = !!disabled; return b; }
const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const RANK = { member: 1, mod: 2, admin: 3, owner: 4 };

let tok = localStorage.getItem('cr_tok');
if (!tok) { tok = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); localStorage.setItem('cr_tok', tok); }
const socket = io({ auth: { tok } });

let ME = null, me = '', myId = null, SERVERS = [], S = null, ch = null, view = 'chat', histKey = '';
let games = [], files = [], tasks = [], cur = null, uploadTarget = null;
const cards = new Map(), seen = new Set(), unread = {}, pinged = {};
let lastMsg = null, titleCount = 0, audioCtx = null, showingCode = false, pendingJoin = null, firstMe = true;
try { pendingJoin = new URLSearchParams(location.search).get('join'); } catch (e) {}
const feed = $('feed');

// ---------- people (cached profile cards) ----------
let pendingCards = new Set(), cardTimer = 0;
function need(uid) {
  if (!uid || cards.has(uid) || pendingCards.has(uid)) return;
  pendingCards.add(uid); clearTimeout(cardTimer);
  cardTimer = setTimeout(() => {
    const ids = [...pendingCards]; pendingCards.clear();
    socket.emit('users:get', ids, (r) => { ((r && r.cards) || []).forEach((c) => cards.set(c.uid, c)); repaint(); });
  }, 60);
}
function paintAv(e) {
  const c = cards.get(e.dataset.uid), s = e.style;
  e.textContent = ''; s.backgroundImage = ''; s.background = '';
  if (!e.dataset.uid) { s.background = '#4e5058'; e.textContent = '🤖'; return; }
  if (!c) { need(e.dataset.uid); s.background = '#4e5058'; return; }
  if (c.avatar && c.avatar.t === 'img') s.backgroundImage = 'url(' + c.avatar.v + ')';
  else { s.background = (c.avatar && c.avatar.c) || '#5865f2'; e.textContent = (c.avatar && c.avatar.v) || '🙂'; }
  if (e.dataset.online === '1' && S && S.online.includes(e.dataset.uid)) e.append(h('i', 'dot', null));
}
function avatar(uid, size, online) {
  const e = h('div', 'av', { dataset: { uid: uid || '', online: online ? '1' : '' }, style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.55)}px` });
  paintAv(e); return e;
}
function repaint() {
  document.querySelectorAll('.av[data-uid]').forEach(paintAv);
  document.querySelectorAll('.nm[data-uid]').forEach((e) => { const c = cards.get(e.dataset.uid); if (c) e.textContent = c.display; });
  if (S) drawMembers();
}
const nameOf = (uid, fallback) => { const c = cards.get(uid); if (!c) need(uid); return c ? c.display : (fallback || '…'); };

// ---------- small UI helpers ----------
let toastTimer = 0;
function toast(text) { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200); }
const showError = (t) => { $('error').textContent = t || ''; $('error').hidden = !t; };
function showBlocked(title, msg) { $('blockedTitle').textContent = title; $('blockedMsg').textContent = msg; $('blocked').hidden = false; }
function openSheet(...nodes) { const b = $('sheetBox'); b.textContent = ''; b.append(...nodes.flat().filter(Boolean)); $('sheet').hidden = false; $('scrim').hidden = false; }
function closeSheet() { $('sheet').hidden = true; if (!document.querySelector('.drawer.open')) $('scrim').hidden = true; }
function openDrawer(id) { $(id).classList.add('open'); $('scrim').hidden = false; }
function closeDrawers() { document.querySelectorAll('.drawer.open').forEach((d) => d.classList.remove('open')); $('scrim').hidden = $('sheet').hidden; }
$('scrim').onclick = () => { closeSheet(); closeDrawers(); $('scrim').hidden = true; };
$('btnMenu').onclick = () => openDrawer('drawerL');
$('btnMembers').onclick = () => { drawMembers(); openDrawer('drawerR'); };
const roleName = (r) => ({ owner: 'Owner', admin: 'Admin', mod: 'Moderator', member: 'Member' }[r] || 'Member');
const myRank = () => RANK[S && S.role] || 0;
const copyText = (t) => { if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('Copied'), () => toast('Copy failed')); else toast('Copy not available'); };

// ---------- navigation ----------
const VIEW_ID = { chat: 'vChat', servers: 'vServers', dms: 'vDMs', you: 'vYou', games: 'vGames', work: 'vWork', voice: 'vVoice', settings: 'vSettings', admin: 'vAdmin' };
const PANELS = ['games', 'work', 'voice', 'settings', 'admin'];
function go(v) {
  view = v;
  document.querySelectorAll('.view').forEach((s) => { s.hidden = s.id !== VIEW_ID[v]; });
  drawTop(); closeDrawers(); closeSheet(); $('scrim').hidden = true;
  document.querySelectorAll('#bottomNav button').forEach((b) => b.classList.toggle('on', b.dataset.nav === (PANELS.includes(v) && v !== 'admin' ? 'chat' : v === 'admin' ? 'you' : v)));
  if (v === 'chat') { ensureHistory(); clearUnread(S && S.id + '|' + ch); }
  if (v === 'servers') drawServers();
  if (v === 'dms') showDmList();
  if (v === 'you') drawYou();
  if (v === 'settings') drawSettings();
  if (v === 'admin') drawAdmin();
  if (v === 'games') drawGames();
  if (v === 'voice') drawVoice();
}
function drawTop() {
  const chat = view === 'chat', panel = PANELS.includes(view);
  $('btnMenu').hidden = !chat; $('btnApps').hidden = !chat; $('btnMembers').hidden = !chat; $('tBack').hidden = !panel;
  let main, sub = '';
  if (chat) { main = S ? S.name : 'Common Room'; const c = S && S.channels.find((x) => x.id === ch); sub = c ? '# ' + c.name : ''; }
  else { main = { servers: 'Servers', dms: 'Messages', you: 'You', games: 'Games', work: 'Workspace', voice: 'Voice', settings: 'Server settings', admin: 'Admin' }[view]; if (['games', 'work', 'voice', 'settings'].includes(view) && S) sub = S.name; }
  $('tMain').textContent = main; $('tSub').textContent = sub;
  $('dServer').textContent = S ? S.name : '';
}
$('tBack').onclick = () => go(view === 'admin' ? 'you' : 'chat');
document.querySelectorAll('#bottomNav button').forEach((b) => { b.onclick = () => go(b.dataset.nav); });
$('btnApps').onclick = () => openSheet(h('h3', 'Open in ' + (S ? S.name : 'this server')),
  h('button', 'sheetbtn', { onclick: () => go('games') }, '🎮 Games'), h('button', 'sheetbtn', { onclick: () => go('work') }, '🛠 Workspace: files, tasks, builds'),
  h('button', 'sheetbtn', { onclick: () => go('voice') }, '🔊 Voice chat'));
$('dSettings').onclick = () => go('settings');

// ---------- servers ----------
function switchServer(id) {
  socket.emit('server:open', { id }, (r) => {
    if (!r || r.error) return toast((r && r.error) || 'Could not open that server.');
    applyState(r.state); go('chat');
  });
}
function applyState(st) {
  const switched = !S || S.id !== st.id;
  S = st; files = st.files; tasks = st.tasks; builds = st.builds; games = st.games; vlist = st.voice;
  if (switched) {
    feed.textContent = ''; seen.clear(); lastMsg = null; histKey = ''; cur = null; doc = null; cursors = new Map();
    $('editor').textContent = ''; $('editor').append(h('p', 'empty', 'Pick a file, create one, or upload scripts, models and textures.')); $('wsFiles').classList.remove('editing');
    if (inVoice) leaveVoice();
  }
  if (!ch || !st.channels.some((c) => c.id === ch)) ch = st.channels[0].id;
  drawTop(); drawChannels(); drawMembers(); drawGames(); drawFiles(); drawTasks(); drawBuilds(); drawVoice(); drawServers();
  if (view === 'chat') ensureHistory();
  if (view === 'settings') drawSettings();
}
function drawChannels() {
  const box = $('chanList'); box.textContent = '';
  if (!S) return;
  S.channels.forEach((c) => {
    const k = S.id + '|' + c.id, n = unread[k] || 0;
    box.append(h('button', (c.id === ch ? 'on ' : '') + (n ? 'unread' : ''), { onclick: () => openChannel(c.id) }, h('span', '# ' + c.name), n ? h('span', 'badge', String(n)) : null));
  });
}
function openChannel(id) { ch = id; histKey = ''; go('chat'); drawChannels(); }
const srvUnread = (sid) => Object.keys(unread).filter((k) => k.startsWith(sid + '|')).reduce((n, k) => n + unread[k], 0);
function clearUnread(k) { if (!k) return; unread[k] = 0; pinged[k] = 0; drawChannels(); updateBadges(); }
let dmUnread = 0;
function updateBadges() {
  const here = S ? srvUnread(S.id) : 0, other = SERVERS.filter((s) => !S || s.id !== S.id).reduce((n, s) => n + srvUnread(s.id), 0);
  const set = (id, n) => { $(id).hidden = !n; $(id).textContent = n > 99 ? '99+' : n; };
  set('bChat', here); set('bSrv', other); set('bDm', dmUnread);
}
function drawServers() {
  const box = $('srvList'); box.textContent = '';
  SERVERS.forEach((s) => {
    const n = srvUnread(s.id);
    box.append(h('button', 'item', { onclick: () => switchServer(s.id) },
      h('div', 'av', { style: 'width:44px;height:44px;font-size:20px;background:#5865f2' }, s.name.slice(0, 1).toUpperCase()),
      h('div', 'grow', h('b', s.name), h('small', s.lobby ? 'Public lobby' : roleName(s.role) + (s.members ? ' · ' + s.members + ' members' : ''))),
      n ? h('span', 'badge', String(n)) : null, S && S.id === s.id ? h('small', '● open') : null));
  });
}
$('newSrvBtn').onclick = () => {
  socket.emit('server:create', { name: $('newSrvName').value }, (r) => {
    if (!r || r.error) return toast((r && r.error) || 'Could not create it.');
    $('newSrvName').value = ''; switchServer(r.id); toast('Server created. Open ⚙ to make an invite link.');
  });
};
function joinByCode(v) {
  const m = /join=([A-Za-z0-9]+)/.exec(String(v)), code = m ? m[1] : String(v).trim();
  socket.emit('server:join', { code }, (r) => {
    if (!r || r.error) return toast((r && r.error) || 'Could not join.');
    $('joinCode').value = ''; switchServer(r.id); toast('Joined!');
  });
}
$('joinBtn').onclick = () => joinByCode($('joinCode').value);

// ---------- members & profile sheet ----------
socket.on('presence', (p) => { if (S && S.id === p.server) { S.online = p.online; drawMembers(); } });
function roleOf(uid) { const c = cards.get(uid); if (S.lobby) return (c && c.admin) ? 'owner' : (S.roles[uid] || 'member'); return S.roles[uid] || 'member'; }
function drawMembers() {
  const box = $('memList'); box.textContent = '';
  if (!S) return;
  const ids = S.lobby ? S.online : S.memberIds, on = new Set(S.online);
  $('memCount').textContent = ids.length + (S.lobby ? ' online' : '');
  ids.forEach(need);
  const order = ['owner', 'admin', 'mod', 'member'], groups = { owner: [], admin: [], mod: [], member: [] };
  ids.forEach((uid) => groups[roleOf(uid)].push(uid));
  order.forEach((r) => {
    const list = groups[r].sort((a, b) => (on.has(b) - on.has(a)) || nameOf(a).localeCompare(nameOf(b)));
    if (!list.length) return;
    box.append(h('div', 'dsec', roleName(r) + ' · ' + list.length));
    list.forEach((uid) => {
      const c = cards.get(uid);
      box.append(h('button', 'mem' + (on.has(uid) ? '' : ' off'), { onclick: () => openProfile(uid) }, avatar(uid, 34, true),
        h('div', 'grow', h('b', { className: 'nm', textContent: c ? c.display : '…' }), c && c.status ? h('small', c.status) : null)));
    });
  });
}
function openProfile(uid) {
  closeDrawers();
  socket.emit('users:get', [uid], (r) => {
    const c = r && r.cards && r.cards[0]; if (!c) return;
    cards.set(c.uid, c);
    const mine = ME && c.uid === ME.uid, rk = S ? roleOf(uid) : 'member', canMod = S && !mine && myRank() >= RANK.mod && myRank() > RANK[rk];
    const nodes = [h('div', 'profile', avatar(uid, 84), h('h2', c.display), h('div', 'muted', '@' + c.username + ' · ' + c.job + (c.admin ? ' · site admin' : '') + (S ? ' · ' + roleName(rk) : '')),
      c.status ? h('div', c.status) : null, c.bio ? h('div', 'bio', c.bio) : null, h('small', 'Joined ' + new Date(c.created).toLocaleDateString()))];
    if (mine) nodes.push(h('button', 'sheetbtn', { onclick: () => go('you') }, '✏️ Edit my profile'));
    else {
      nodes.push(h('button', 'sheetbtn', { onclick: () => { closeSheet(); go('dms'); openDM(uid); } }, '✉️ Send a message'));
      nodes.push(h('button', 'sheetbtn dim', { onclick: () => openReport({ type: 'user', uid }) }, '🚩 Report user'));
    }
    if (canMod) {
      const act = (ev, p, msg) => socket.emit(ev, p, (x) => { toast(x && x.error ? x.error : msg); if (!x || !x.error) closeSheet(); });
      nodes.push(h('h3', 'Moderation'), h('div', 'chips',
        [['Mute 10m', 10], ['Mute 1h', 60], ['Mute 1d', 1440], ['Unmute', 0]].map(([l, m]) => btn(l, () => act('mod:mute', { uid, minutes: m }, 'Done'))),
        S.lobby ? null : btn('Kick', () => act('mod:kick', { uid }, 'Kicked')),
        (S.lobby || myRank() < RANK.admin) ? null : btn('Ban', () => { if (confirm('Ban this person from the server?')) act('mod:ban', { uid }, 'Banned'); })));
    }
    if (S && myRank() >= RANK.owner && !mine && !(S.lobby && c.admin) && (S.lobby || S.roles[uid])) {
      nodes.push(h('h3', 'Role'), h('div', 'chips', ['member', 'mod', 'admin'].map((r) => btn(roleName(r), () => socket.emit('role:set', { uid, role: r }, (x) => { toast(x && x.error ? x.error : 'Role updated'); closeSheet(); })))));
    }
    openSheet(nodes);
  });
}
function openReport(ref) {
  const t = h('textarea', { placeholder: 'What is wrong? (optional, up to 300 characters)', maxLength: 300 });
  openSheet(h('h3', 'Report'), h('small', ref.type === 'dm' ? 'The last 20 messages of this conversation will be attached.' : 'Moderators will see the reported content and the messages around it.'), t,
    h('button', { onclick: () => socket.emit('report:send', { ...ref, reason: t.value }, (r) => { toast(r && r.error ? r.error : 'Thanks, your report was sent.'); closeSheet(); }) }, 'Send report'));
}

// ---------- chat ----------
function fmt(text) {
  const frag = document.createDocumentFragment();
  text.split(/(https?:\/\/[^\s<]+)/g).forEach((part, i) => {
    if (i % 2) { const a = el('a', part); a.href = part; a.target = '_blank'; a.rel = 'noopener noreferrer'; frag.append(a); return; }
    part.split(/(@[A-Za-z0-9_]{2,20})/g).forEach((p, j) => {
      if (j % 2) frag.append(h('span', 'mtag' + (ME && p.slice(1).toLowerCase() === ME.username.toLowerCase() ? ' me' : ''), p)); else if (p) frag.append(p);
    });
  });
  return frag;
}
function renderMsg(m) {
  if (seen.has(m.id)) return; seen.add(m.id); need(m.uid);
  const emp = $('empty'); if (emp) emp.remove();
  const near = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
  const cont = lastMsg && lastMsg.uid === m.uid && m.time - lastMsg.time < 300000 && lastMsg.ch === m.ch;
  lastMsg = m;
  const c = cards.get(m.uid);
  const row = h('div', 'msg' + (cont ? ' cont' : ''), { dataset: { id: m.id, uid: m.uid || '' } });
  if (mentionsMe(m)) row.classList.add('mention');
  const gut = h('div', 'gut', cont ? null : avatar(m.uid, 36));
  if (!cont) gut.firstChild.onclick = () => m.uid && openProfile(m.uid);
  const head = cont ? null : h('div', 'head', h('span', 'nm', { dataset: { uid: m.uid || '' }, textContent: c ? c.display : m.name, onclick: () => m.uid && openProfile(m.uid) }),
    m.adm ? h('span', 'role adm', 'admin') : (m.role && m.role !== 'Other' ? h('span', 'role', m.role) : null), h('span', 'time', fmtTime(m.time)));
  const body = h('div', 'body', head, m.text ? h('div', 'bubble', fmt(m.text)) : null);
  if (m.file) {
    const box = h('div', 'media', null), f = m.file;
    if (f.kind === 'image') { const i = el('img'); i.src = f.url; i.alt = f.name; i.loading = 'lazy'; box.append(i); }
    else if (f.kind === 'video') { const v = el('video'); v.src = f.url; v.controls = true; v.preload = 'metadata'; box.append(v); }
    else if (f.kind === 'audio') { const a = el('audio'); a.src = f.url; a.controls = true; box.append(a); }
    else { const a = el('a', f.name, 'filecard'); a.href = f.url; a.download = f.name; a.append(el('span', 'Download · ' + fmtSize(f.size))); box.append(a); }
    body.append(box);
  }
  row.append(gut, body);
  row.onclick = (e) => { if (!e.target.closest('a,video,audio,.av,.nm,img')) openMsgSheet(m); };
  feed.append(row);
  if (near || (ME && m.uid === ME.uid)) feed.scrollTop = feed.scrollHeight;
}
function openMsgSheet(m) {
  const mineMsg = ME && m.uid === ME.uid, nodes = [h('small', m.text ? m.text.slice(0, 120) : (m.file ? m.file.name : ''))];
  if (m.text) nodes.push(h('button', 'sheetbtn', { onclick: () => { copyText(m.text); closeSheet(); } }, '📋 Copy text'));
  if (m.uid && !mineMsg) {
    nodes.push(h('button', 'sheetbtn', { onclick: () => { closeSheet(); go('dms'); openDM(m.uid); } }, '✉️ Message ' + nameOf(m.uid, m.name)));
    nodes.push(h('button', 'sheetbtn dim', { onclick: () => openReport({ type: 'message', server: m.server, ch: m.ch, id: m.id }) }, '🚩 Report message'));
  }
  if (mineMsg || myRank() >= RANK.mod) nodes.push(h('button', 'sheetbtn danger', { onclick: () => { socket.emit('msg:delete', { ch: m.ch, id: m.id }, (r) => toast(r && r.error ? r.error : 'Deleted')); closeSheet(); } }, '🗑 Delete message'));
  openSheet(nodes);
}
function ensureHistory() {
  if (!S) return;
  const key = S.id + '|' + ch; if (histKey === key) return; histKey = key;
  feed.textContent = ''; seen.clear(); lastMsg = null;
  socket.emit('chat:history', { ch }, (r) => {
    if (!r || !r.ok || histKey !== key) return;
    if (!r.msgs.length) feed.append(h('p', 'empty', { id: 'empty' }, 'Nobody has said anything here yet.'));
    r.msgs.forEach(renderMsg); feed.scrollTop = feed.scrollHeight;
  });
  $('text').placeholder = 'Message #' + ((S.channels.find((c) => c.id === ch) || {}).name || '') + '  (@username to ping)';
  clearUnread(key);
}
socket.on('msg:deleted', (d) => { const n = feed.querySelector('[data-id="' + d.id + '"]'); if (n) n.remove(); });
socket.on('message', (m) => {
  need(m.uid);
  const key = m.server + '|' + m.ch, mine = ME && m.uid === ME.uid, ping = mentionsMe(m);
  const here = S && S.id === m.server && m.ch === ch && view === 'chat';
  if (here) renderMsg(m);
  else if (!mine) { unread[key] = (unread[key] || 0) + 1; if (ping) pinged[key] = (pinged[key] || 0) + 1; drawChannels(); updateBadges(); drawServers(); }
  if (!mine && (!here || document.hidden)) { if (document.hidden) { titleCount++; document.title = '(' + titleCount + ') Common Room'; } if (ping) alertPing(nameOf(m.uid, m.name) + ' pinged you', m.text); }
});
function mentionsMe(m) {   // @yourusername, @everyone / @all, or @your-job (@dev, @tester, @modeler)
  if (!ME || !m.text || m.uid === ME.uid) return false;
  const t = m.text.toLowerCase();
  return ['everyone', 'all', ME.username.toLowerCase(), ME.job.toLowerCase()].some((w) => {
    let i = t.indexOf('@' + w);
    while (i !== -1) { const after = t[i + w.length + 1]; if (!after || !/\w/.test(after)) return true; i = t.indexOf('@' + w, i + 1); }
    return false;
  });
}
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.15);
  } catch (e) {}
}
function alertPing(title, body) {
  beep(); if (navigator.vibrate) navigator.vibrate(200);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { const n = new Notification(title, { body: String(body || '').slice(0, 120), tag: 'ping' }); n.onclick = () => { window.focus(); n.close(); }; } catch (e) {}
  }
}
document.addEventListener('click', () => { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.resume) audioCtx.resume(); } catch (e) {} }, { once: true });
function resetTitle() { if (!document.hidden) { titleCount = 0; document.title = 'Common Room'; } }
document.addEventListener('visibilitychange', resetTitle); window.addEventListener('focus', resetTitle);

const fileEl = $('file'), textEl = $('text');
function updatePicked() { const f = fileEl.files[0]; $('picked').hidden = !f; if (f) $('pickedName').textContent = f.name + ' (' + fmtSize(f.size) + ')'; }
fileEl.onchange = () => { const f = fileEl.files[0]; if (f && f.size > 10 * 1024 * 1024) { showError('Files can be up to 10 MB.'); fileEl.value = ''; } else showError(''); updatePicked(); };
$('clearFile').onclick = () => { fileEl.value = ''; updatePicked(); };
$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = textEl.value.trim(), file = fileEl.files[0];
  if (!text && !file) return;
  $('send').disabled = true; showError('');
  try {
    if (file) {
      const fd = new FormData(); fd.append('sid', myId || ''); fd.append('ch', ch); fd.append('text', text); fd.append('file', file);
      const res = await fetch('/api/post', { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not send.');
    } else {
      await new Promise((ok, bad) => socket.emit('chat:send', { ch, text }, (r) => (r && r.ok ? ok() : bad(new Error((r && r.error) || 'Could not send.')))));
    }
    textEl.value = ''; fileEl.value = ''; updatePicked();
  } catch (err) { showError(err.message); }
  finally { $('send').disabled = false; textEl.focus(); }
};

// ---------- games ----------
document.querySelectorAll('#gbar [data-new]').forEach((b) => { b.onclick = () => socket.emit('game:create', b.dataset.new); });
const NAMES = { ttt: 'Tic-Tac-Toe', c4: 'Connect 4', rps: 'Rock Paper Scissors', hc: 'Hand Cricket', hf: 'Hand Football' };
const HC = [[1, '1 finger'], [2, '2 fingers'], [3, '3 fingers'], [4, '4 fingers'], [5, 'palm · left'], [6, 'thumb only'], [10, 'palm · down'], [20, 'palm · up']];
const RPS = { rock: '✊ Rock', paper: '✋ Paper', scissors: '✌️ Scissors' };

function drawGames() {
  const box = $('gamelist');
  box.textContent = '';
  const mine = games.find((g) => g.hostSid === myId || g.guestSid === myId);
  if (mine) box.appendChild(gameView(mine));
  games.filter((g) => g !== mine && g.status === 'waiting').forEach((g) => {
    const row = el('div', null, 'grow2');
    row.appendChild(el('span', `${g.host} · ${NAMES[g.type]}`));
    if (!mine) row.appendChild(btn('Join', () => socket.emit('game:join', g.id)));
    box.appendChild(row);
  });
  if (!box.children.length) box.appendChild(el('div', 'No games yet. Start one!', 'grow2'));
}
function gameView(g) {
  const v = el('div', null, 'game'), host = g.hostSid === myId;
  v.appendChild(el('h3', `${NAMES[g.type]}: ${g.host} vs ${g.guest || '…'}`));
  let status = '';
  if (g.type === 'hf') {
    status = hfView(g, v, host);
  } else if (g.type === 'hc' && !g.hc) {
    status = 'Waiting for an opponent… (the toss happens when they join)';
  } else if (g.type === 'hc') {
    const h = g.hc, meBat = (h.batter === 'host') === host, picked = g.picked.includes(myId);
    const sb = el('div', null, 'sb');
    sb.appendChild(el('div', `Innings ${h.innings}/2 · ` + (meBat ? 'you are BATTING' : 'you are BOWLING')));
    sb.appendChild(el('div', `${g.host}: ${h.scores.host}  ·  ${g.guest || '…'}: ${h.scores.guest}`));
    if (h.target != null) sb.appendChild(el('div', `Target ${h.target + 1} · need ${Math.max(0, h.target + 1 - h.scores[h.batter])} more`));
    v.appendChild(sb);
    const hrow = el('div', null, 'row hc');
    HC.forEach(([n, cap]) => {
      const b = btn('', () => socket.emit('game:move', { id: g.id, v: n }), g.status !== 'playing' || picked);
      b.append(el('b', String(n)), el('small', cap));
      hrow.appendChild(b);
    });
    v.appendChild(hrow);
    if (h.last) v.appendChild(el('div', `Last ball: bat ${h.last.bat} vs bowl ${h.last.bowl} — ` + (h.last.out ? 'OUT!' : '+' + h.last.bat), 'hclast'));
    if (h.log.length) v.appendChild(el('small', 'Recent: ' + h.log.map((x) => (x.out ? 'OUT' : x.bat)).join(' · ')));
    status = g.status === 'waiting' ? 'Waiting for an opponent…'
      : g.status === 'done' ? (g.winner === 'draw' ? 'Tie!' : g.winner === myId ? 'You win! 🎉' : 'You lost.')
      : picked ? 'Waiting for them…' : (meBat ? 'Pick your shot' : 'Pick your delivery');
  } else if (g.type === 'rps') {
    const picked = g.picked.includes(myId), row = el('div', null, 'row');
    Object.keys(RPS).forEach((k) => row.appendChild(btn(RPS[k], () => socket.emit('game:move', { id: g.id, v: k }), g.status !== 'playing' || picked)));
    v.appendChild(row);
    if (g.status === 'waiting') status = 'Waiting for an opponent…';
    else if (g.status === 'done') {
      const mineP = host ? g.shown.host : g.shown.guest, theirs = host ? g.shown.guest : g.shown.host;
      status = `You: ${RPS[mineP]} · Them: ${RPS[theirs]} — ` + (g.winner === 'draw' ? 'Draw!' : g.winner === myId ? 'You win! 🎉' : 'You lost.');
    } else status = picked ? 'Waiting for them…' : 'Make your pick';
  } else {
    const c4 = g.type === 'c4', mark = host ? (c4 ? 'R' : 'X') : (c4 ? 'Y' : 'O');
    const bd = el('div', null, c4 ? 'c4' : 'board');
    g.board.forEach((c, i) => {
      const b = btn(c4 ? '●' : c, () => socket.emit('game:move', { id: g.id, v: c4 ? i % 7 : i }),
        g.status !== 'playing' || g.turn !== mark || (!c4 && !!c));
      if (c4) b.className = c ? 'c' + c : '', b.style.color = c ? '' : 'transparent';
      bd.appendChild(b);
    });
    v.appendChild(bd);
    status = g.status === 'waiting' ? 'Waiting for an opponent…'
      : g.status === 'done' ? (g.winner === 'draw' ? 'Draw!' : g.winner === mark ? 'You win! 🎉' : 'You lost.')
      : g.turn === mark ? 'Your turn' + (c4 ? (mark === 'R' ? ' (red)' : ' (yellow)') : ` (${mark})`) : 'Their turn';
  }
  v.appendChild(el('div', status, 'st'));
  const row = el('div', null, 'row');
  if (g.status === 'done') row.appendChild(btn('Rematch', () => socket.emit('game:rematch', g.id)));
  row.appendChild(btn('Leave', () => socket.emit('game:leave')));
  v.appendChild(row);
  return v;
}

// ---------- hand football ----------
const HF_PEN = { 'index': '☝️ Index finger', 'index+middle': '✌️ Index + middle', 'thumb': '👍 Thumb' };
function hfView(g, v, host) {
  if (!g.hf) return 'Waiting for an opponent… (the toss happens when they join)';
  const h = g.hf, mine = host ? 'host' : 'guest', nm = (x) => (x === 'host' ? g.host : g.guest) || '…';
  const picked = g.picked.includes(myId), playing = g.status === 'playing' && h.phase === 'play';
  const penalty = h.stage === 'pens' || (h.stage === 'main' && h.attempt === 11);
  const send = (val) => socket.emit('game:move', { id: g.id, v: val });
  const sb = el('div', null, 'sb');
  const stage = h.phase === 'choose' ? 'Penalty shootout · toss'
    : h.stage === 'main' ? `Attempt ${Math.min(h.attempt, h.max)}/${h.max}`
    : h.stage === 'extra' ? `Extra time ${Math.min(h.attempt, h.max)}/${h.max}`
    : `Penalty shootout · round ${h.round} (${h.pen.tries} tries each)`;
  sb.appendChild(el('div', stage));
  sb.appendChild(el('div', `⚽ ${g.host} ${h.score.host} – ${h.score.guest} ${g.guest || '…'}`));
  if (h.pen && h.pen.goals) sb.appendChild(el('div', `🥅 Shootout: ${g.host} ${h.pen.goals.host} – ${h.pen.goals.guest} ${g.guest || '…'} · ${nm(h.pen.attacker)} shooting (try ${Math.min(h.pen.taken + 1, h.pen.tries)}/${h.pen.tries})`));
  if (h.stage !== 'pens' && h.phase === 'play') sb.appendChild(el('div', penalty ? `🎯 FREE PENALTY for ${nm(h.poss)}` : `🏐 Ball: ${nm(h.poss)}`));
  if (h.toss) sb.appendChild(el('small', `🪙 Toss for ${h.toss.why}: ${nm(h.toss.winner)} won`));
  if (h.penHistory.length) sb.appendChild(el('small', ' · earlier rounds: ' + h.penHistory.map((r) => r.host + '–' + r.guest).join(', ')));
  v.appendChild(sb);
  const row = el('div', null, 'row hc');
  if (h.phase === 'choose') {
    if (h.toss.winner === mine) {
      row.appendChild(btn('⚔️ Attack first', () => send('attack')));
      row.appendChild(btn('🛡️ Defend first', () => send('defend')));
    }
  } else if (penalty) {
    Object.keys(HF_PEN).forEach((k) => row.appendChild(btn(HF_PEN[k], () => send(k), !playing || picked)));
  } else {
    for (let n = 1; n <= 6; n++) {
      const b = btn('', () => send(n), !playing || picked);
      b.append(el('b', String(n)), el('small', n === 1 ? 'finger' : 'fingers'));
      row.appendChild(b);
    }
  }
  v.appendChild(row);
  if (h.last) v.appendChild(el('div', h.last, 'hclast'));
  if (h.log.length > 1) v.appendChild(el('small', 'Before: ' + h.log.slice(1).join('  ·  ')));
  if (g.status === 'waiting') return 'Waiting for an opponent…';
  if (g.status === 'done') return g.winner === myId ? 'You win! 🎉' : 'You lost.';
  if (h.phase === 'choose') return h.toss.winner === mine ? 'You won the toss: attack or defend first?' : `${nm(h.toss.winner)} is choosing…`;
  if (picked) return 'Waiting for them…';
  if (h.stage === 'pens') return h.pen.attacker === mine ? 'You shoot: pick your finger(s)' : 'You keep: try to match their finger(s)';
  if (penalty) return h.poss === mine ? 'Free penalty: pick your finger(s)' : 'Defend the penalty: try to match';
  return 'Pick 1–6 fingers';
}

// ---------- voice (WebRTC mesh, signaling over socket.io) ----------
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const peers = {};
let localStream = null, inVoice = false, muted = false, vlist = [], sigChain = Promise.resolve();

socket.on('voice:list', (l) => {
  vlist = l;
  Object.keys(peers).forEach((id) => { if (!l.some((p) => p.id === id)) dropPeer(id); });
  drawVoice();
});
function drawVoice() {
  const box = $('vlist');
  box.textContent = '';
  vlist.forEach((p) => box.appendChild(el('div', '🎙 ' + p.name + (p.id === myId && muted ? ' (muted)' : ''))));
  $('vjoin').textContent = inVoice ? 'Leave' : 'Join';
  $('vmute').hidden = !inVoice;
  $('vmute').textContent = muted ? 'Unmute' : 'Mute';
  $('voicePill').hidden = !inVoice; $('vpMute').textContent = muted ? 'Unmute' : 'Mute';
}
function mkPeer(id) {
  const pc = new RTCPeerConnection(ICE);
  peers[id] = pc;
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => e.candidate && socket.emit('voice:signal', { to: id, data: { ice: e.candidate } });
  pc.ontrack = (e) => {
    let a = document.getElementById('a-' + id);
    if (!a) { a = el('audio'); a.id = 'a-' + id; a.autoplay = true; $('audios').appendChild(a); }
    a.srcObject = e.streams[0];
  };
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) dropPeer(id); };
  return pc;
}
function dropPeer(id) {
  peers[id]?.close(); delete peers[id];
  document.getElementById('a-' + id)?.remove();
}
async function callPeer(id) {
  const pc = mkPeer(id);
  await pc.setLocalDescription(await pc.createOffer());
  socket.emit('voice:signal', { to: id, data: { sdp: pc.localDescription } });
}
socket.on('voice:signal', (m) => { sigChain = sigChain.then(() => handleSignal(m)).catch(() => {}); });
async function handleSignal({ from, data }) {
  if (!inVoice || !data) return;
  let pc = peers[from];
  if (data.sdp && data.sdp.type === 'offer') {
    pc = pc || mkPeer(from);
    await pc.setRemoteDescription(data.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    socket.emit('voice:signal', { to: from, data: { sdp: pc.localDescription } });
  } else if (data.sdp && pc) await pc.setRemoteDescription(data.sdp);
  else if (data.ice && pc) await pc.addIceCandidate(data.ice);
}
async function leaveVoice() {
  inVoice = false; muted = false;
  Object.keys(peers).forEach(dropPeer);
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  socket.emit('voice:leave');
  drawVoice();
}
$('vjoin').onclick = async () => {
  if (inVoice) return leaveVoice();
  try { localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { alert('Microphone blocked or unavailable (voice needs HTTPS and mic permission).'); return; }
  inVoice = true;
  socket.emit('voice:join', (others) => others.forEach((p) => callPeer(p.id).catch(() => {})));
  drawVoice();
};
$('vmute').onclick = () => {
  muted = !muted;
  localStream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  drawVoice();
};


$('vpMute').onclick = () => $('vmute').onclick();
$('vpLeave').onclick = () => leaveVoice();
// ---------- workspace: files ----------
document.querySelectorAll('#vWork [data-wst]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#vWork [data-wst]').forEach((x) => x.classList.toggle('on', x === b));
    $('wsFiles').hidden = b.dataset.wst !== 'files';
    $('wsTasks').hidden = b.dataset.wst !== 'tasks';
    $('wsBuilds').hidden = b.dataset.wst !== 'builds';
  };
});
socket.on('ws:files', (f) => { files = f; drawFiles(); });
let doc = null, lastText = '', cursors = new Map(), rafId = 0, curTimer = 0, cwCache = {};
const keyOf = (n) => (n === doc.head ? '' : n.n + '.' + n.c);
const hueOf = (id) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
function sendCursor() {
  clearTimeout(curTimer);
  curTimer = setTimeout(() => {
    const ta = $('ta');
    if (!doc || !ta || !cur) return;
    socket.emit('doc:cursor', { name: cur.name, a: keyOf(doc.nodeAt(ta.selectionStart)), b: keyOf(doc.nodeAt(ta.selectionEnd)) });
  }, 60);
}
document.addEventListener('selectionchange', () => { if (document.activeElement && document.activeElement.id === 'ta') sendCursor(); });
socket.on('doc:cursor', (c) => { cursors.set(c.id, c); renderCursors(); });
socket.on('doc:gone', (id) => { cursors.delete(id); renderCursors(); });
function renderCursors() { if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; drawCursors(); }); }
function charWidth(cs) {
  const f = cs.fontSize + ' ' + cs.fontFamily;
  if (!cwCache[f]) { const x = document.createElement('canvas').getContext('2d'); x.font = f; cwCache[f] = x.measureText('0'.repeat(100)).width / 100; }
  return cwCache[f];
}
function drawCursors() {
  const ta = $('ta'), layer = $('curlayer');
  if (!ta || !layer || !doc) return;
  layer.textContent = '';
  const cs = getComputedStyle(ta), lh = parseFloat(cs.lineHeight) || 19, cw = charWidth(cs);
  const px = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), py = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
  const text = ta.value;
  const pos = (off) => {   // line and column (tabs are 2 wide) of a text offset
    let line = 0, ls = 0;
    for (let i = text.indexOf('\n'); i !== -1 && i < off; i = text.indexOf('\n', i + 1)) { line++; ls = i + 1; }
    let col = 0;
    for (let i = ls; i < off; i++) col += text[i] === '\t' ? 2 - (col % 2) : 1;
    return { line, col };
  };
  cursors.forEach((c) => {
    const na = doc.map.get(c.a), nb = doc.map.get(c.b);
    if (!na) return;
    const oa = doc.offsetOf(na), ob = nb ? doc.offsetOf(nb) : oa;
    const s = Math.min(oa, ob), e = Math.max(oa, ob), hue = hueOf(c.id);
    const p1 = pos(s), p2 = pos(e);
    if (e > s && e - s < 20000) {
      text.slice(s, e).split('\n').forEach((seg, k, all) => {
        const r = el('div', null, 'sel');
        r.style.cssText = `left:${px + (k ? 0 : p1.col) * cw - ta.scrollLeft}px;top:${py + (p1.line + k) * lh - ta.scrollTop}px;width:${(seg.length + (k < all.length - 1 ? 1 : 0)) * cw}px;height:${lh}px;background:hsla(${hue},70%,60%,.28)`;
        layer.appendChild(r);
      });
    }
    const y = py + p2.line * lh - ta.scrollTop;
    const caret = el('div', null, 'caret');
    caret.style.cssText = `left:${px + p2.col * cw - ta.scrollLeft}px;top:${y}px;height:${lh}px;background:hsl(${hue},70%,55%)`;
    const flag = el('span', c.user, 'flag');
    flag.style.cssText = `background:hsl(${hue},70%,40%);top:${y < 16 ? lh : -15}px`;
    caret.appendChild(flag);
    layer.appendChild(caret);
  });
}
window.addEventListener('resize', renderCursors);
socket.on('ws:updated', ({ name, by }) => {
  if (!cur || cur.name !== name) return;
  if (cur.kind === 'bin' && by !== me) openFile(name); else refreshHist();
});
socket.on('doc:reset', (name) => {
  if (cur && cur.name === name) { setBanner('File was reloaded (restore, import or cleanup).', ''); openFile(name); }
});
socket.on('doc:ops', ({ name, ops }) => {
  const ta = $('ta');
  if (!doc || !ta || !cur || cur.name !== name) return;
  const a = doc.nodeAt(ta.selectionStart), b = doc.nodeAt(ta.selectionEnd), top = ta.scrollTop;
  ops.forEach((o) => doc.apply(o));
  lastText = ta.value = doc.text();
  ta.setSelectionRange(doc.offsetOf(a), doc.offsetOf(b));
  ta.scrollTop = top;
  renderCursors();
});
socket.on('disconnect', (reason) => {
  if (reason === 'io server disconnect') { $('blockedTitle').textContent = 'Opened somewhere else'; $('blockedMsg').textContent = 'Common Room was opened in another tab or window from this browser, so this one was closed. Refresh to take over again.'; $('blocked').hidden = false; return; }
  const ta = $('ta'); if (ta) { ta.readOnly = true; setBanner('Disconnected, reconnecting…', 'bad'); } });
socket.on('connect', () => { if (cur) { setBanner(''); openFile(cur.name); } });
function diffText(a, b) {
  let p = 0; const m = Math.min(a.length, b.length);
  while (p < m && a[p] === b[p]) p++;
  let s = 0;
  while (s < m - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { p, del: a.length - p - s, ins: b.slice(p, b.length - s) };
}
function setBanner(text, kind, action) {
  const b = $('banner');
  b.textContent = ''; b.hidden = !text;
  b.className = 'banner ' + (kind || '');
  if (!text) return;
  b.appendChild(el('span', text));
  if (action) b.appendChild(btn(action[0], action[1]));
}
function drawFiles() {
  const box = $('filelist');
  box.textContent = '';
  if (!files.length) box.appendChild(el('p', 'No files yet. Create or upload one.', 'empty'));
  [...files].sort((a, b) => a.name.localeCompare(b.name)).forEach((f) => {
    const b = btn('', () => { setBanner(''); openFile(f.name); });
    b.className = 'frow' + (cur && cur.name === f.name ? ' on' : '');
    b.append(el('b', (f.kind === 'bin' ? '📦 ' : '📄 ') + f.name),
      el('span', `v${f.v} · ${f.by}${f.role ? ' (' + f.role + ')' : ''}` + (f.editing.length ? ' · ✎ ' + f.editing.join(', ') : '')));
    box.appendChild(b);
  });
  const cf = cur && files.find((x) => x.name === cur.name);
  if (cf && $('editingNow')) $('editingNow').textContent = cf.editing.length ? 'Editing now: ' + cf.editing.join(', ') : '';
}
$('newFile').onclick = () => {
  const name = (prompt('New file name (e.g. scripts/player.gd)') || '').trim();
  if (!name) return;
  socket.emit('ws:create', name, (r) => { if (r.error) setBanner(r.error, 'bad'); else openFile(name); });
};
$('assetFile').onchange = async () => {
  const f = $('assetFile').files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append('sid', myId || ''); fd.append('note', 'uploaded');
  if (uploadTarget) fd.append('name', uploadTarget);
  fd.append('file', f);
  uploadTarget = null; $('assetFile').value = '';
  try {
    const r = await fetch('/api/asset', { method: 'POST', body: fd });
    if (!r.ok) throw new Error((await r.json()).error || 'Upload failed.');
    setBanner('Uploaded ' + f.name, 'ok');
  } catch (e) { setBanner(e.message, 'bad'); }
};

function renderHist(history) {
  const box = $('hist');
  if (!box) return;
  box.textContent = '';
  box.appendChild(el('b', 'Saved versions'));
  history.forEach((h, i) => {
    const r = el('div');
    r.appendChild(el('span', `v${h.v} · ${h.by}${h.role ? ' (' + h.role + ')' : ''} · ${fmtTime(h.time)}${h.note ? ' — ' + h.note : ''}`));
    if (cur.kind === 'text' && i > 0) r.appendChild(btn('Restore', () => {
      if (confirm('Replace the live text for everyone with v' + h.v + '?')) socket.emit('ws:restore', { name: cur.name, v: h.v }, (x) => { if (x.error) setBanner(x.error, 'bad'); });
    }));
    box.appendChild(r);
  });
}
function refreshHist() { if (cur) socket.emit('ws:hist', cur.name, (r) => { cur.v = r.v; renderHist(r.history); }); }

function openFile(name) {
  socket.emit('ws:open', name, (res) => {
    const ed = $('editor');
    ed.textContent = '';
    if (res.error) { cur = null; doc = null; ed.appendChild(el('p', 'File not found.', 'empty')); drawFiles(); return; }
    cur = { name, kind: res.kind, v: res.v };
    const back = btn('← Files', () => $('wsFiles').classList.remove('editing')); back.className = 'ghost';
    ed.appendChild(back); $('wsFiles').classList.add('editing');
    ed.appendChild(el('h3', name));
    const who = el('div', null, 'hist'); who.id = 'editingNow'; ed.appendChild(who);

    if (res.kind === 'bin') {
      doc = null; cursors = new Map();
      ed.appendChild(el('p', `Binary file · ${fmtSize(res.size || 0)} · v${res.v}`));
      const row = el('div', null, 'row');
      const a = el('a', 'Download latest', 'filecard'); a.href = res.url; a.download = name;
      row.append(a, btn('Upload new version', () => { uploadTarget = name; $('assetFile').click(); }));
      ed.appendChild(row);
    } else {
      doc = Doc.from(res.runs, Math.random().toString(36).slice(2, 8));
      const ta = el('textarea'); ta.id = 'ta'; ta.spellcheck = false;
      ta.value = lastText = doc.text();
      ta.wrap = 'off';
      ta.oninput = () => {
        const d = diffText(lastText, ta.value);
        lastText = ta.value;
        const ops = doc.local(d.p, d.del, d.ins);
        if (ops.length) socket.emit('doc:ops', { name, ops });
        renderCursors(); sendCursor();
      };
      ta.onscroll = renderCursors;
      ta.onkeyup = ta.onclick = ta.onfocus = sendCursor;
      ta.onkeydown = (e) => {
        if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
      };
      const wrap = el('div', null, 'edwrap'), layer = el('div', null, 'curlayer');
      layer.id = 'curlayer';
      wrap.append(ta, layer);
      ed.appendChild(wrap);
      cursors = new Map((res.cursors || []).map((c) => [c.id, c]));
      renderCursors();
      const note = el('input'); note.type = 'text'; note.placeholder = 'Version note (optional)'; note.maxLength = 100;
      const row = el('div', null, 'row');
      row.append(note, btn('💾 Save version', () => socket.emit('ws:save', { name, note: note.value }, (r) => {
        if (r.ok) { note.value = ''; setBanner('Saved as v' + r.v, 'ok'); } else setBanner(r.error, 'bad');
      })));
      ed.appendChild(row);
      ed.appendChild(el('small', 'Live: everyone with this file open edits the same text, and you can see their cursors.'));
    }

    const hist = el('div', null, 'hist'); hist.id = 'hist'; ed.appendChild(hist);
    renderHist(res.history);
    ed.appendChild(btn('Delete file', () => {
      if (confirm('Delete ' + name + ' and its versions for everyone?')) socket.emit('ws:delete', name, (r) => { if (r && r.error) setBanner(r.error, 'bad'); else { cur = null; doc = null; ed.textContent = ''; $('wsFiles').classList.remove('editing'); } });
    }));
    drawFiles();
  });
}

// ---------- workspace: tasks ----------
socket.on('tasks', (t) => { tasks = t; drawTasks(); });
const COLS = [['todo', 'To do'], ['doing', 'Doing'], ['done', 'Done']];
function drawTasks() {
  const box = $('cols');
  box.textContent = '';
  COLS.forEach(([st, label], ci) => {
    const list = tasks.filter((t) => t.status === st), col = el('div', null, 'col');
    col.appendChild(el('h4', `${label} (${list.length})`));
    list.forEach((t) => {
      const c = el('div', null, 'card');
      c.append(el('span', t.type, 'tag ' + t.type), el('div', t.title),
        el('small', 'by ' + t.by + (t.assignee ? ' · ✋ ' + t.assignee : '')));
      const r = el('div', null, 'row');
      if (ci > 0) r.appendChild(btn('←', () => socket.emit('task:move', { id: t.id, status: COLS[ci - 1][0] })));
      r.appendChild(btn(t.assignee === me ? 'Drop' : 'Take', () => socket.emit('task:claim', t.id)));
      if (ci < 2) r.appendChild(btn('→', () => socket.emit('task:move', { id: t.id, status: COLS[ci + 1][0] })));
      r.appendChild(btn('✕', () => socket.emit('task:del', t.id)));
      c.appendChild(r); col.appendChild(c);
    });
    box.appendChild(col);
  });
}
$('taskForm').onsubmit = (e) => {
  e.preventDefault();
  const title = $('taskTitle').value.trim();
  if (!title) return;
  socket.emit('task:add', { title, type: $('taskType').value });
  $('taskTitle').value = '';
};

// ---------- workspace: playable builds ----------
let builds = [];
socket.on('builds', (b) => { builds = b; drawBuilds(); });
function drawBuilds() {
  const box = $('buildlist');
  box.textContent = '';
  if (!builds.length) box.appendChild(el('p', 'No builds yet. Upload a .zip of your web export.', 'empty'));
  builds.forEach((b, i) => {
    const c = el('div', null, 'card');
    c.append(el('b', (i === 0 ? '⭐ ' : '') + b.name),
      el('small', `by ${b.by}${b.role ? ' (' + b.role + ')' : ''} · ${new Date(b.time).toLocaleString()} · ${b.files} files · ${fmtSize(b.size)}`));
    const r = el('div', null, 'row');
    const a = el('a', '▶ Play', 'filecard'); a.href = '/play/' + b.id + '/'; a.target = '_blank'; a.rel = 'noopener';
    r.append(a,
      btn('Copy link', () => { if (navigator.clipboard) navigator.clipboard.writeText(location.origin + '/play/' + b.id + '/'); }),
      btn('Delete', () => { if (confirm('Delete build "' + b.name + '" for everyone?')) socket.emit('build:del', b.id, (r) => r && r.error && toast(r.error)); }));
    c.appendChild(r);
    box.appendChild(c);
  });
}
$('buildFile').onchange = async () => {
  const f = $('buildFile').files[0];
  if (!f) return;
  const name = (prompt('Name this build (e.g. v0.3 alpha)', f.name.replace(/\.zip$/i, '')) || '').trim();
  const fd = new FormData();
  fd.append('sid', myId || ''); fd.append('name', name);
  fd.append('file', f);
  $('buildFile').value = '';
  $('buildMsg').textContent = 'Uploading and unpacking ' + f.name + '… this can take a while.';
  try {
    const r = await fetch('/api/build', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Upload failed.');
    $('buildMsg').textContent = 'Uploaded! Tap Play on the new build.';
  } catch (e) { $('buildMsg').textContent = 'Error: ' + e.message; }
};


// ======================= direct messages =======================
let threads = [], dmWith = null;
socket.on('dm', (d) => {
  need(d.with);
  const mine = ME && d.from === ME.uid;
  if (view === 'dms' && dmWith === d.with && !$('dmConv').hidden) { addDmBubble(d.msg); if (!mine) socket.emit('dm:read', { uid: d.with }); return; }
  loadThreads();
  if (!mine) { alertPing(nameOf(d.from) + ' sent you a message', d.msg.text); toast('✉️ ' + nameOf(d.from) + ': ' + d.msg.text.slice(0, 60)); }
});
function loadThreads() {
  socket.emit('dm:threads', (r) => {
    if (!r || !r.ok) return;
    threads = r.threads; threads.forEach((t) => cards.set(t.uid, t.card));
    dmUnread = threads.reduce((n, t) => n + t.unread, 0); updateBadges();
    if (view === 'dms' && $('dmConv').hidden) drawThreads();
  });
}
function showDmList() { $('dmConv').hidden = true; $('dmList').hidden = false; dmWith = null; drawThreads(); loadThreads(); }
function drawThreads() {
  const box = $('dmList'); box.textContent = '';
  const q = h('input', { type: 'text', placeholder: 'Find someone by username…', maxLength: 20 }), res = h('div');
  q.oninput = () => {
    const v = q.value.trim();
    if (v.length < 2) { res.textContent = ''; return; }
    socket.emit('users:find', v, (r) => {
      res.textContent = '';
      ((r && r.cards) || []).forEach((c) => { cards.set(c.uid, c); res.append(h('button', 'item', { onclick: () => openDM(c.uid) }, avatar(c.uid, 40), h('div', 'grow', h('b', c.display), h('small', '@' + c.username)))); });
      if (!res.children.length) res.append(h('p', 'empty', 'Nobody found.'));
    });
  };
  box.append(h('h2', 'Messages'), q, res);
  if (!threads.length) box.append(h('p', 'empty', 'No conversations yet. Search for a username above, or tap someone in a chat.'));
  threads.forEach((t) => box.append(h('button', 'item', { onclick: () => openDM(t.uid) }, avatar(t.uid, 44),
    h('div', 'grow', h('b', { className: 'nm', dataset: { uid: t.uid }, textContent: t.card.display }), h('small', (t.last.from === (ME && ME.uid) ? 'You: ' : '') + t.last.text)),
    t.unread ? h('span', 'badge', String(t.unread)) : null)));
}
function addDmBubble(m) { const f = $('dmFeed'); f.append(h('div', 'dmmsg' + (ME && m.from === ME.uid ? ' mine' : ''), m.text)); f.scrollTop = f.scrollHeight; }
function openDM(uid) {
  if (view !== 'dms') go('dms');
  socket.emit('dm:open', { uid }, (r) => {
    if (!r || r.error) return toast((r && r.error) || 'Could not open it.');
    cards.set(r.card.uid, r.card); dmWith = uid;
    $('dmList').hidden = true; $('dmConv').hidden = false;
    $('dmWho').textContent = ''; $('dmWho').append(avatar(uid, 34), h('b', { className: 'nm', dataset: { uid }, textContent: r.card.display }));
    $('dmWho').onclick = () => openProfile(uid);
    const f = $('dmFeed'); f.textContent = ''; r.msgs.forEach(addDmBubble);
    if (!r.msgs.length) f.append(h('p', 'empty', 'Say hi 👋'));
    $('dmMenu').onclick = () => openSheet(h('button', 'sheetbtn', { onclick: () => openProfile(uid) }, '👤 View profile'),
      h('button', 'sheetbtn', { onclick: () => socket.emit('user:block', { uid, block: !r.blocked }, () => { r.blocked = !r.blocked; toast(r.blocked ? 'Blocked' : 'Unblocked'); closeSheet(); }) }, r.blocked ? '✅ Unblock' : '🚫 Block'),
      h('button', 'sheetbtn dim', { onclick: () => openReport({ type: 'dm', uid }) }, '🚩 Report this conversation'));
    loadThreads();
  });
}
$('dmBack').onclick = () => showDmList();
$('dmForm').onsubmit = (e) => {
  e.preventDefault(); const t = $('dmText').value.trim(); if (!t || !dmWith) return;
  socket.emit('dm:send', { to: dmWith, text: t }, (r) => { if (r && r.error) toast(r.error); else { $('dmText').value = ''; const em = $('dmFeed').querySelector('.empty'); if (em) em.remove(); } });
};

// ======================= you: profile, account, alerts =======================
const EMOJIS = ['🙂', '😎', '🤖', '🦊', '🐼', '🐯', '🦁', '🐸', '🐙', '👾', '🎮', '🚀', '🔥', '⚡', '🌟', '🍕', '🎧', '🧠', '🐉', '🦄', '🌈', '💎', '🥷', '👑'];
const COLORS = ['#5865f2', '#23a559', '#f23f42', '#faa61a', '#eb459e', '#00a8fc', '#9b59b6', '#e67e22', '#4e5058'];
function drawYou() {
  const box = $('youBox'); box.textContent = '';
  if (!ME) { box.append(h('p', 'empty', 'Create an account to get started.')); return; }
  let av = ME.avatar || { t: 'emoji', v: '🙂', c: '#5865f2' };
  const prev = h('div'), repaintPrev = () => { prev.textContent = ''; const d = h('div', 'av', { style: 'width:84px;height:84px;font-size:46px;margin:0 auto' }); if (av.t === 'img') d.style.backgroundImage = 'url(' + av.v + ')'; else { d.style.background = av.c; d.textContent = av.v; } prev.append(d); };
  repaintPrev();
  const emojiGrid = h('div', 'emojis', EMOJIS.map((e) => btn(e, () => { av = { t: 'emoji', v: e, c: av.t === 'emoji' ? av.c : '#5865f2' }; repaintPrev(); })));
  const swatches = h('div', 'swatches', COLORS.map((c) => { const b = btn('', () => { av = { t: 'emoji', v: av.t === 'emoji' ? av.v : '🙂', c }; repaintPrev(); }); b.style.background = c; return b; }));
  const photo = h('input', { type: 'file', accept: 'image/*', hidden: true });
  photo.onchange = () => {
    const f = photo.files[0]; if (!f) return;
    const img = new Image(); img.onload = () => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 96; const s = Math.min(img.width, img.height), cx = cv.getContext('2d');
      cx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 96, 96);
      let q = 0.75, data = cv.toDataURL('image/jpeg', q); while (data.length > 38000 && q > 0.3) { q -= 0.1; data = cv.toDataURL('image/jpeg', q); }
      av = { t: 'img', v: data }; repaintPrev();
    }; img.src = URL.createObjectURL(f);
  };
  const display = h('input', { type: 'text', value: ME.display, maxLength: 24 }), status = h('input', { type: 'text', value: ME.status, maxLength: 60, placeholder: 'What are you up to?' });
  const bio = h('textarea', { value: ME.bio, maxLength: 150, placeholder: 'A few words about you' });
  const job = h('select', ['Dev', 'Modeler', 'Tester', 'Other'].map((j) => h('option', { value: j, selected: j === ME.job }, j)));
  const save = h('button', { onclick: () => socket.emit('me:update', { display: display.value, status: status.value, bio: bio.value, job: job.value, avatar: av }, (r) => toast(r && r.error ? r.error : 'Profile saved')) }, 'Save profile');
  box.append(h('div', 'box', h('h3', 'Profile'), prev, h('div', 'row', btn('📷 Photo', () => photo.click()), photo), emojiGrid, swatches,
    h('small', 'Display name'), display, h('small', 'You can change it once every 10 minutes. Your username stays the same.'),
    h('small', 'Status'), status, h('small', 'About me'), bio, h('small', 'Role tag'), job, h('div', 'row', save)));
  const alerts = h('button', 'dim', { onclick: () => { try { Notification.requestPermission().then(() => { alerts.textContent = Notification.permission === 'granted' ? '🔔 Alerts on' : '🔔 Alerts blocked in browser settings'; }); } catch (e) {} } },
    ('Notification' in window && Notification.permission === 'granted') ? '🔔 Alerts on' : '🔔 Enable alerts');
  const dmoff = h('input', { type: 'checkbox', checked: !!ME.dmOff, onchange: () => socket.emit('me:dmoff', { off: dmoff.checked }, () => toast(dmoff.checked ? 'DMs are off' : 'DMs are on')) });
  box.append(h('div', 'box', h('h3', 'Account'), h('div', 'muted', 'Username: @' + ME.username + " (can't be changed)"),
    h('div', 'warn', 'Your recovery code is the only way to get this account back on a new device or after clearing your browser. Lost it? Make a new one (the old one stops working).'),
    h('div', 'row', btn('🔑 New recovery code', () => { if (confirm('Make a new recovery code? The old one will stop working.')) socket.emit('account:newcode', (r) => (r && r.ok ? showCode(r.code, false) : toast((r && r.error) || 'Failed'))); }), alerts),
    h('label', 'row', dmoff, h('span', 'Turn off direct messages'))));
  if (ME.admin) box.append(h('div', 'box', h('h3', 'Site admin'), h('button', { onclick: () => go('admin') }, '🛡 Open admin panel')));
  else {
    const key = h('input', { type: 'password', placeholder: 'Admin key', autocomplete: 'off' });
    box.append(h('div', 'box', h('h3', 'Admin key'), h('small', 'Only for the site owner.'), h('div', 'row', key, btn('Unlock', () => socket.emit('admin:login', { key: key.value }, (r) => toast(r && r.error ? r.error : 'Admin unlocked'))))));
  }
}
function showCode(code, first) {
  showingCode = true;
  const chk = h('input', { type: 'checkbox' }), go2 = h('button', { disabled: true, onclick: () => { showingCode = false; $('setup').hidden = true; if (first) onFirstReady(); } }, 'Continue');
  chk.onchange = () => { go2.disabled = !chk.checked; };
  const box = h('div', 'card2', { id: 'setupBox' }, h('h2', 'Save your recovery code'), h('p', 'This code is shown only once. It is the only way to recover your account on another device or if you clear your browser data.'),
    h('div', 'code', code), h('div', 'row', btn('Copy', () => copyText(code))), h('label', 'row', chk, h('span', 'I saved it somewhere safe')), go2);
  $('setupBox').replaceWith(box); $('setup').hidden = false;
}

// ======================= server settings =======================
function drawSettings() {
  const box = $('setBox'); box.textContent = '';
  if (!S) return;
  const rk = myRank(), isAdmin = rk >= RANK.admin, base = location.origin + '/?join=';
  box.append(h('h2', S.name), h('div', 'muted', 'Your role: ' + roleName(S.role)));
  if (isAdmin) {
    const nm = h('input', { type: 'text', value: S.name, maxLength: 30 });
    box.append(h('div', 'box', h('h3', 'Name'), h('div', 'row', nm, btn('Rename', () => socket.emit('server:rename', { name: nm.value }, (r) => toast(r && r.error ? r.error : 'Renamed'))))));
  }
  if (!S.lobby && isAdmin) {
    const exp = h('select', [['24', '1 day'], ['1', '1 hour'], ['168', '7 days'], ['0', 'Never']].map(([v, l]) => h('option', { value: v }, l)));
    const max = h('select', [['0', 'Unlimited uses'], ['1', 'One use'], ['5', '5 uses'], ['25', '25 uses']].map(([v, l]) => h('option', { value: v }, l)));
    const list = h('div');
    (S.invites || []).forEach((i) => list.append(h('div', 'item', h('div', 'grow', h('b', i.code), h('small', i.uses + (i.max ? '/' + i.max : '') + ' uses · ' + (i.expires ? 'expires ' + new Date(i.expires).toLocaleString() : 'never expires'))),
      btn('Copy link', () => copyText(base + i.code)), btn('Revoke', () => socket.emit('invite:revoke', { code: i.code }, () => {})))));
    box.append(h('div', 'box', h('h3', 'Invite people'), h('small', 'Only people with a link can join. Nobody else can find this server.'), h('div', 'row', exp, max),
      h('button', { onclick: () => socket.emit('invite:create', { hours: Number(exp.value), max: Number(max.value) }, (r) => { if (r && r.error) toast(r.error); else copyText(base + r.code); }) }, 'Create invite link'), list));
  }
  if (isAdmin) {
    const nc = h('input', { type: 'text', placeholder: 'new-channel', maxLength: 20 });
    box.append(h('div', 'box', h('h3', 'Channels'),
      S.channels.map((c) => h('div', 'item', h('div', 'grow', h('b', '# ' + c.name)), S.channels.length > 1 ? btn('Delete', () => { if (confirm('Delete #' + c.name + ' and its messages?')) socket.emit('channel:del', { id: c.id }, (r) => r && r.error && toast(r.error)); }) : null)),
      h('div', 'row', nc, btn('Add', () => socket.emit('channel:add', { name: nc.value }, (r) => toast(r && r.error ? r.error : 'Channel added'))))));
  }
  if (!S.lobby) {
    const ids = S.memberIds || [];
    ids.forEach(need);
    box.append(h('div', 'box', h('h3', 'Members (' + ids.length + ')'),
      ids.map((uid) => h('button', 'mem', { onclick: () => openProfile(uid) }, avatar(uid, 32, true), h('div', 'grow', h('b', { className: 'nm', dataset: { uid }, textContent: nameOf(uid) })), h('small', roleName(roleOf(uid)))))));
    if (isAdmin && (S.banned || []).length) box.append(h('div', 'box', h('h3', 'Banned'), S.banned.map((uid) => h('div', 'item', h('div', 'grow', h('b', { className: 'nm', dataset: { uid }, textContent: nameOf(uid) })), btn('Unban', () => socket.emit('mod:unban', { uid }, () => {}))))));
    const danger = h('div', 'box', h('h3', 'More'));
    if (rk < RANK.owner) danger.append(h('button', 'dim', { onclick: () => openReport({ type: 'server', server: S.id }) }, '🚩 Report this server'), h('div', 'row', null), h('button', 'danger', { onclick: () => { if (confirm('Leave ' + S.name + '?')) socket.emit('server:leave', { id: S.id }, (r) => r && r.error && toast(r.error)); } }, 'Leave server'));
    else danger.append(h('button', 'danger', { onclick: () => { if (confirm('Delete ' + S.name + ' and everything in it for good?')) socket.emit('server:delete', { id: S.id }, (r) => r && r.error && toast(r.error)); } }, 'Delete server'));
    box.append(danger);
  } else box.append(h('div', 'box', h('small', "The lobby is public. To change someone's role, tap them in the member list.")));
}

// ======================= site admin panel =======================
let admTab = 'reports';
function drawAdmin() {
  const box = $('admBox'); box.textContent = '';
  box.append(h('div', 'tabs2', ['reports', 'users', 'audit'].map((t) => h('button', t === admTab ? 'on' : '', { onclick: () => { admTab = t; drawAdmin(); } }, t[0].toUpperCase() + t.slice(1)))));
  const body = h('div'); box.append(body);
  if (admTab === 'reports') socket.emit('admin:reports', { status: 'open' }, (r) => {
    if (!r || r.error) return body.append(h('p', 'empty', (r && r.error) || 'Failed'));
    if (!r.reports.length) body.append(h('p', 'empty', 'No open reports 🎉'));
    r.reports.forEach((x) => {
      const act = (a) => socket.emit('admin:act', { id: x._id, action: a }, (y) => { toast(y && y.error ? y.error : 'Done'); drawAdmin(); });
      const ev = h('div', { style: 'display:none;margin-top:6px' }, (x.snapshot || []).map((m) => h('div', h('small', (m.name || '?') + ': '), m.text)));
      const review = () => socket.emit('admin:serverReview', { id: x.server }, (y) => {
        if (y && y.error) return toast(y.error);
        openSheet(h('h3', y.name), h('small', 'Read-only review · ' + y.members + ' members'), y.channels.map((c) => h('div', h('b', '# ' + c.name), c.msgs.map((m) => h('div', h('small', (m.name || '?') + ': '), m.text)))));
      });
      const btns = h('div', 'chips', btn('Dismiss', () => act('dismiss')), x.type === 'message' ? btn('Delete message', () => act('delmsg')) : null,
        x.targetCard ? [btn('Mute 24h', () => act('mute')), btn('Ban', () => { if (confirm('Ban @' + x.targetCard.username + '?')) act('ban'); }),
          btn('Ban + IP', () => { if (confirm('Ban the account AND its IP? Shared networks may be affected.')) act('banip'); })] : null,
        x.type === 'server' ? [btn('Review server', review), btn('Delete server', () => { if (confirm('Delete this server for good?')) act('delserver'); })] : null);
      body.append(h('div', 'box', h('b', x.type.toUpperCase() + (x.serverName ? ' · ' + x.serverName : '')),
        h('div', 'muted', 'by @' + x.reporterName + ' → ' + (x.targetCard ? '@' + x.targetCard.username : '?') + ' · ' + new Date(x.time).toLocaleString()),
        x.reason ? h('div', x.reason) : h('small', 'No reason given.'),
        h('button', 'dim', { onclick: () => { ev.style.display = ev.style.display === 'none' ? 'block' : 'none'; } }, 'Show evidence (' + (x.snapshot || []).length + ')'), ev, btns));
    });
  });
  if (admTab === 'users') {
    const q = h('input', { type: 'text', placeholder: 'Username prefix, or type: banned', maxLength: 20 }), out = h('div');
    const find = () => socket.emit('admin:users', { q: q.value }, (r) => {
      out.textContent = '';
      ((r && r.users) || []).forEach((u) => {
        const note = u.banned ? 'BANNED: ' + (u.banned.reason || '') : 'names: ' + u.nameHistory.map((n) => n.name).join(', ');
        let action = null;
        if (u.banned) action = btn('Unban', () => socket.emit('admin:unban', { uid: u.uid }, () => { toast('Unbanned'); find(); }));
        else if (!u.admin) action = btn('Ban', () => { if (confirm('Ban @' + u.username + '?')) socket.emit('admin:ban', { uid: u.uid, reason: 'Banned by an admin', ip: false }, () => { toast('Banned'); find(); }); });
        out.append(h('div', 'item', avatar(u.uid, 38), h('div', 'grow', h('b', u.display + ' @' + u.username), h('small', note)), action));
      });
    });
    q.oninput = find;
    body.append(q, out, h('div', 'row', btn('Clear all IP bans', () => socket.emit('admin:clearips', () => toast('IP bans cleared')))));
    find();
  }
  if (admTab === 'audit') socket.emit('admin:audit', (r) => ((r && r.entries) || []).forEach((e) => body.append(h('div', 'item', h('div', 'grow',
    h('b', e.action + (e.targetName ? ' → @' + e.targetName : '')), h('small', (e.byName ? '@' + e.byName + ' · ' : '') + new Date(e.time).toLocaleString() + (e.info ? ' · ' + e.info : '')))))));
}

// ======================= account setup (first visit) =======================
function openSetup() { $('setup').hidden = false; drawSetup('new'); }
function drawSetup(mode) {
  const box = h('div', 'card2', { id: 'setupBox' });
  box.append(h('h2', 'Welcome to Common Room'), h('div', 'tabs2', h('button', mode === 'new' ? 'on' : '', { onclick: () => drawSetup('new') }, 'New here'), h('button', mode === 'rec' ? 'on' : '', { onclick: () => drawSetup('rec') }, 'I have an account')));
  const err = h('div', 'warn', { hidden: true }), fail = (m) => { err.textContent = m; err.hidden = false; };
  if (mode === 'new') {
    const user = h('input', { type: 'text', placeholder: 'Username (permanent)', maxLength: 20, autocapitalize: 'off', autocomplete: 'off' });
    const disp = h('input', { type: 'text', placeholder: 'Display name (you can change it later)', maxLength: 24, value: localStorage.getItem('cr_name') || '' });
    const job = h('select', ['Dev', 'Modeler', 'Tester', 'Other'].map((j) => h('option', { value: j }, j)));
    const key = h('input', { type: 'password', placeholder: 'Admin key (site owner only)', autocomplete: 'off' });
    const go1 = h('button', { onclick: () => { go1.disabled = true; socket.emit('account:register', { username: user.value, display: disp.value || user.value, job: job.value, adminKey: key.value || undefined }, (r) => { go1.disabled = false; if (!r || r.error) return fail((r && r.error) || 'Failed'); showCode(r.code, true); }); } }, 'Create account');
    box.append(h('small', 'No email or password. Your username is permanent; your display name can change.'), user, h('div', 'row', null), disp, h('div', 'row', null), job, h('details', h('summary', 'Site owner?'), key), err, h('div', 'row', go1));
  } else {
    const user = h('input', { type: 'text', placeholder: 'Username', maxLength: 20, autocapitalize: 'off' }), code = h('input', { type: 'text', placeholder: 'XXXX-XXXX-XXXX-XXXX', maxLength: 24, autocapitalize: 'characters', autocomplete: 'off' });
    box.append(h('small', 'Use the recovery code you saved when you created the account.'), user, h('div', 'row', null), code, err,
      h('div', 'row', h('button', { onclick: () => socket.emit('account:recover', { username: user.value, code: code.value }, (r) => { if (!r || r.error) return fail((r && r.error) || 'Failed'); $('setup').hidden = true; }) }, 'Sign in')));
  }
  $('setupBox').replaceWith(box);
}
function onFirstReady() { if (pendingJoin) { joinByCode(pendingJoin); pendingJoin = null; try { history.replaceState(null, '', location.pathname); } catch (e) {} } }

// ======================= session events =======================
socket.on('connect', () => { myId = socket.id; });
socket.on('connect_error', (e) => {
  const m = e && e.message;
  if (m === 'ip-busy') showBlocked("Someone's already here from your network", 'This room allows one person per IP address to keep bots out. Close the other tab or device, wait a few seconds, then refresh.');
  else if (m === 'banned') showBlocked('Access blocked', 'This network or account has been banned from Common Room.');
});
socket.on('need-account', openSetup);
socket.on('me', (m) => {
  ME = m; me = m.display; cards.set(m.uid, m);
  if (!showingCode) $('setup').hidden = true;
  if (firstMe) { firstMe = false; loadThreads(); if (!showingCode) onFirstReady(); }
  if (view === 'you') drawYou();
  repaint();
});
socket.on('servers', (l) => { SERVERS = l; drawServers(); updateBadges(); });
socket.on('server:state', applyState);
socket.on('card', (c) => { cards.set(c.uid, c); if (ME && c.uid === ME.uid) ME = Object.assign(ME, c); repaint(); });
socket.on('notice', (n) => toast(n.text));
socket.on('kicked', (k) => { if (k.why) toast(k.why); });
socket.on('banned', (b) => { $('setup').hidden = true; showBlocked('You are banned', (b && b.reason) ? 'Reason: ' + b.reason : 'This account has been banned.'); });
socket.on('games', (g) => { games = g; drawGames(); });

// ======================= start =======================
go('chat');
