const $ = (id) => document.getElementById(id);
const CHANNELS = ['general', 'games', 'random', 'dev'];
const feed = $('feed'), form = $('composer'), textEl = $('text'), fileEl = $('file');
const sendBtn = $('send'), errBox = $('error');

let ch = 'general', myId = null, games = [], files = [], tasks = [], cur = null, uploadTarget = null;
let me = localStorage.getItem('cr_name') || '', role = localStorage.getItem('cr_role') || 'Dev';
const socket = io();
const hello = () => socket.emit('hello', { name: me, role });

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function btn(text, fn, disabled) { const b = el('button', text); b.type = 'button'; b.onclick = fn; b.disabled = !!disabled; return b; }
const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const showError = (t) => { errBox.textContent = t || ''; errBox.hidden = !t; };

function askName() {
  const n = (prompt('Pick a display name (up to 24 characters)', me || '') || '').trim().slice(0, 24);
  me = n || me || 'Guest' + Math.floor(Math.random() * 900 + 100);
  localStorage.setItem('cr_name', me);
  $('me').textContent = me;
  if (socket.connected) hello();
}
if (!me) askName(); else $('me').textContent = me;
$('rename').onclick = askName;
$('role').value = role;
$('role').onchange = (e) => { role = e.target.value; localStorage.setItem('cr_role', role); hello(); };

socket.on('connect', () => { myId = socket.id; hello(); drawGames(); });
socket.on('connect_error', (e) => { if (e.message === 'ip-busy') $('blocked').hidden = false; });
socket.on('online', (n) => { $('online').textContent = n + ' here'; });
socket.on('games', (g) => { games = g; drawGames(); });
socket.on('message', (m) => {
  if (m.ch === ch && !$('chatView').hidden) render(m);
  else document.querySelector(`[data-ch="${m.ch}"]`)?.classList.add('unread');
});

// ---------- navigation ----------
[...CHANNELS, 'workspace'].forEach((c) => {
  const b = el('button', c === 'workspace' ? '🛠 Workspace' : '# ' + c);
  b.dataset.ch = c;
  b.onclick = () => (c === 'workspace' ? openWorkspace() : openChannel(c));
  $('tabs').appendChild(b);
});
function markTabs(c) {
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.ch === c);
    if (b.dataset.ch === c) b.classList.remove('unread');
  });
}
const seen = new Set();
function openChannel(c) {
  ch = c; seen.clear(); feed.textContent = '';
  $('chatView').hidden = false; $('wsView').hidden = true;
  markTabs(c);
  $('games').hidden = c !== 'games';
  textEl.placeholder = 'Message #' + c;
  fetch('/api/messages?ch=' + c).then((r) => r.json()).then((list) => {
    if (c !== ch) return;
    if (!list.length) feed.appendChild(el('p', 'Nobody has said anything here yet.', 'empty')).id = 'empty';
    list.forEach(render);
    feed.scrollTop = feed.scrollHeight;
  });
}
function openWorkspace() {
  $('chatView').hidden = true; $('wsView').hidden = false;
  markTabs('workspace');
}

// ---------- chat ----------
function linkify(node, text) {
  text.split(/(https?:\/\/[^\s<]+)/g).forEach((part, i) => {
    if (i % 2) {
      const a = el('a', part); a.href = part; a.target = '_blank'; a.rel = 'noopener noreferrer';
      node.appendChild(a);
    } else node.appendChild(document.createTextNode(part));
  });
}
function render(m) {
  if (seen.has(m.id)) return;
  seen.add(m.id);
  $('empty')?.remove();
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  const wrap = el('div', null, 'msg');
  const meta = el('div', null, 'meta');
  meta.append(el('b', m.name), m.role ? el('span', m.role, 'role') : '', fmtTime(m.time));
  wrap.appendChild(meta);
  if (m.text) { const d = el('div', null, 'bubble'); linkify(d, m.text); wrap.appendChild(d); }
  if (m.file) {
    const box = el('div', null, 'media'), f = m.file;
    if (f.kind === 'image') { const i = el('img'); i.src = f.url; i.alt = f.name; i.loading = 'lazy'; box.appendChild(i); }
    else if (f.kind === 'video') { const v = el('video'); v.src = f.url; v.controls = true; v.preload = 'metadata'; box.appendChild(v); }
    else if (f.kind === 'audio') { const a = el('audio'); a.src = f.url; a.controls = true; box.appendChild(a); }
    else { const a = el('a', f.name, 'filecard'); a.href = f.url; a.download = f.name; a.appendChild(el('span', 'Download · ' + fmtSize(f.size))); box.appendChild(a); }
    wrap.appendChild(box);
  }
  feed.appendChild(wrap);
  if (nearBottom || m.name === me) feed.scrollTop = feed.scrollHeight;
}
function updatePicked() {
  const f = fileEl.files[0];
  $('picked').hidden = !f;
  if (f) $('pickedName').textContent = f.name + ' (' + fmtSize(f.size) + ')';
}
fileEl.onchange = () => {
  const f = fileEl.files[0];
  if (f && f.size > 10 * 1024 * 1024) { showError('Files can be up to 10 MB.'); fileEl.value = ''; } else showError('');
  updatePicked();
};
$('clearFile').onclick = () => { fileEl.value = ''; updatePicked(); };
form.onsubmit = async (e) => {
  e.preventDefault();
  const text = textEl.value.trim(), file = fileEl.files[0];
  if (!text && !file) return;
  const fd = new FormData();
  fd.append('sid', myId || ''); fd.append('ch', ch); fd.append('text', text);
  if (file) fd.append('file', file);
  sendBtn.disabled = true; showError('');
  try {
    const res = await fetch('/api/post', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not send.');
    textEl.value = ''; fileEl.value = ''; updatePicked();
  } catch (err) { showError(err.message); }
  finally { sendBtn.disabled = false; textEl.focus(); }
};

// ---------- games ----------
document.querySelectorAll('[data-new]').forEach((b) => { b.onclick = () => socket.emit('game:create', b.dataset.new); });
const NAMES = { ttt: 'Tic-Tac-Toe', c4: 'Connect 4', rps: 'Rock Paper Scissors' };
const RPS = { rock: '✊ Rock', paper: '✋ Paper', scissors: '✌️ Scissors' };

function drawGames() {
  const box = $('gamelist');
  box.textContent = '';
  const mine = games.find((g) => g.hostSid === myId || g.guestSid === myId);
  if (mine) box.appendChild(gameView(mine));
  games.filter((g) => g !== mine && g.status === 'waiting').forEach((g) => {
    const row = el('div', null, 'grow');
    row.appendChild(el('span', `${g.host} · ${NAMES[g.type]}`));
    if (!mine) row.appendChild(btn('Join', () => socket.emit('game:join', g.id)));
    box.appendChild(row);
  });
  if (!box.children.length) box.appendChild(el('div', 'No games yet. Start one!', 'grow'));
}
function gameView(g) {
  const v = el('div', null, 'game'), host = g.hostSid === myId;
  v.appendChild(el('h3', `${NAMES[g.type]}: ${g.host} vs ${g.guest || '…'}`));
  let status = '';
  if (g.type === 'rps') {
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

// ---------- workspace: files ----------
document.querySelectorAll('[data-wst]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('[data-wst]').forEach((x) => x.classList.toggle('on', x === b));
    $('wsFiles').hidden = b.dataset.wst !== 'files';
    $('wsTasks').hidden = b.dataset.wst !== 'tasks';
  };
});
socket.on('ws:files', (f) => { files = f; drawFiles(); });
let doc = null, lastText = '';
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
});
socket.on('disconnect', () => { const ta = $('ta'); if (ta) { ta.readOnly = true; setBanner('Disconnected, reconnecting…', 'bad'); } });
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
    ed.appendChild(el('h3', name));
    const who = el('div', null, 'hist'); who.id = 'editingNow'; ed.appendChild(who);

    if (res.kind === 'bin') {
      doc = null;
      ed.appendChild(el('p', `Binary file · ${fmtSize(res.size || 0)} · v${res.v}`));
      const row = el('div', null, 'row');
      const a = el('a', 'Download latest', 'filecard'); a.href = res.url; a.download = name;
      row.append(a, btn('Upload new version', () => { uploadTarget = name; $('assetFile').click(); }));
      ed.appendChild(row);
    } else {
      doc = Doc.from(res.runs, Math.random().toString(36).slice(2, 8));
      const ta = el('textarea'); ta.id = 'ta'; ta.spellcheck = false;
      ta.value = lastText = doc.text();
      ta.oninput = () => {
        const old = lastText, nt = ta.value, d = diffText(old, nt);
        if (d.ins.length > 50000 || d.del > 50000) { alert('That change is too big (max 50,000 characters at once).'); ta.value = old; return; }
        lastText = nt;
        const ops = doc.local(d.p, d.del, d.ins);
        if (ops.length) socket.emit('doc:ops', { name, ops });
      };
      ta.onkeydown = (e) => {
        if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
      };
      ed.appendChild(ta);
      const note = el('input'); note.type = 'text'; note.placeholder = 'Version note (optional)'; note.maxLength = 100;
      const row = el('div', null, 'row');
      row.append(note, btn('💾 Save version', () => socket.emit('ws:save', { name, note: note.value }, (r) => {
        if (r.ok) { note.value = ''; setBanner('Saved as v' + r.v, 'ok'); } else setBanner(r.error, 'bad');
      })));
      ed.appendChild(row);
      ed.appendChild(el('small', 'Live: everyone with this file open edits the same text in real time.'));
    }

    const hist = el('div', null, 'hist'); hist.id = 'hist'; ed.appendChild(hist);
    renderHist(res.history);
    ed.appendChild(btn('Delete file', () => {
      if (confirm('Delete ' + name + ' and its versions for everyone?')) { socket.emit('ws:delete', name); cur = null; doc = null; }
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

openChannel('general');
