'use strict';

/* ---------- мини-хелперы ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function api(path, opts = {}) {
  const o = Object.assign({}, opts);
  if (o.json) {
    o.method = o.method || 'POST';
    o.body = JSON.stringify(o.json);
    o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
    delete o.json;
  }
  const r = await fetch(path, o);
  let data = null;
  try { data = await r.json(); } catch (e) { /* не JSON */ }
  if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
  return data;
}

function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' Б';
  const u = ['КБ', 'МБ', 'ГБ'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + fmtTime(ts);
}

function copyText(text, btn, okLabel) {
  navigator.clipboard.writeText(text).then(() => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = okLabel || 'Скопировано';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1200);
  }).catch(() => {});
}

/* ---------- состояние доступа ---------- */
let authState = { protect: false, trusted: false, methods: {}, me: null };

/* ---------- вкладки ---------- */
$$('.tab').forEach((t) => t.addEventListener('click', async () => {
  const name = t.dataset.tab;
  if ((name === 'qr' || name === 'xfer') && !(await requireAccess())) return;
  showTab(name);
}));

function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
}

/* ---------- QR-модалка (динамическая) ---------- */
async function showQr(text, title) {
  if (!(await requireAccess())) return;
  const back = el('div', 'modalback');
  const m = el('div', 'modal');
  if (title) m.appendChild(el('div', null, title));
  const img = document.createElement('img');
  const src = '/qr?data=' + encodeURIComponent(text) + '&scale=8';
  img.src = src;
  m.appendChild(img);
  const row = el('div', 'row');
  const a = el('a', 'btn', 'Скачать PNG');
  a.href = src; a.download = 'qr.png';
  const b = el('button', 'btn ghost', 'Закрыть');
  row.appendChild(a); row.appendChild(b);
  m.appendChild(row);
  back.appendChild(m);
  document.body.appendChild(back);
  b.addEventListener('click', () => back.remove());
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
}

/* ---------- короткие ссылки ---------- */
let linkCache = [];

async function loadLinks() {
  const list = $('#linkList');
  try {
    const d = await api('/api/links');
    linkCache = d.links || [];
    renderLinks();
  } catch (e) {
    list.replaceChildren(el('div', 'item muted', 'Не удалось загрузить список: ' + e.message));
  }
}

function renderLinks() {
  const list = $('#linkList');
  list.replaceChildren();
  if (!linkCache.length) {
    list.appendChild(el('div', 'item muted', 'Пока пусто. Добавьте первую ссылку выше.'));
    return;
  }
  linkCache.forEach((l) => {
    const item = el('div', 'item');
    const short = location.origin + '/s/' + l.id;
    item.appendChild(el('span', 'linkid', '/' + l.id));
    const a = el('a', 'url', short.length > 60 ? short.slice(0, 57) + '…' : short);
    a.href = '/s/' + l.id; a.target = '_blank'; a.rel = 'noopener';
    const meta = el('span', 'meta', (l.clicks || 0) + ' пер. · ' + fmtDate(l.created)) ;
    const grow = el('span', 'grow');
    const bQr = el('button', 'btn ghost', 'QR');
    bQr.addEventListener('click', () => showQr(short, 'QR для /' + l.id));
    const bCopy = el('button', 'btn ghost', 'Копировать');
    bCopy.addEventListener('click', () => copyText(short, bCopy));
    const bOpen = el('a', 'btn ghost', 'Открыть');
    bOpen.href = '/s/' + l.id; bOpen.target = '_blank'; bOpen.rel = 'noopener';
    const bDel = el('button', 'btn ghost danger', '✕');
    bDel.title = 'Удалить';
    bDel.addEventListener('click', async () => {
      try { await api('/api/links/' + l.id, { method: 'DELETE' }); } catch (e) {}
      loadLinks();
    });
    item.appendChild(a);
    item.appendChild(meta);
    item.appendChild(grow);
    item.appendChild(bQr); item.appendChild(bCopy); item.appendChild(bOpen); item.appendChild(bDel);
    list.appendChild(item);
  });
}

$('#shortForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inp = $('#shortUrl');
  try {
    const d = await api('/api/shorten', { json: { url: inp.value.trim() } });
    inp.value = '';
    linkCache.unshift({ id: d.id, url: '', created: Date.now(), clicks: 0 });
    renderLinks();
    showQr(d.short, 'Готово: ' + d.short);
    loadLinks();
  } catch (err) {
    alert(err.message);
  }
});

/* ---------- QR-генератор ---------- */
$('#qrMake').addEventListener('click', async () => {
  if (!(await requireAccess())) return;
  const text = $('#qrText').value;
  if (!text.trim()) return;
  const src = '/qr?data=' + encodeURIComponent(text) + '&scale=9';
  $('#qrImg2').src = src;
  $('#qrDl').href = src;
  $('#qrOut').hidden = false;
});

/* ---------- передача ---------- */
const xfer = {
  room: null,
  me: '',
  joinUrl: '',
  pollTimer: null,
  lastMsgKey: '',
  waitingAnswers: new Map(),
  busy: false,
};

const NAME_PRESETS = ['Ноутбук', 'Телефон', 'Планшет', 'ПК', 'Смарт', 'Устройство'];
function randomName() {
  return NAME_PRESETS[Math.floor(Math.random() * NAME_PRESETS.length)] + '-' + Math.floor(10 + Math.random() * 89);
}
function ensureName() {
  let n = $('#xferName').value.trim();
  if (!n) { n = randomName(); $('#xferName').value = n; }
  localStorage.setItem('xferName', n);
  return n;
}
$('#xferNameRand').addEventListener('click', () => { $('#xferName').value = randomName(); localStorage.setItem('xferName', $('#xferName').value); });
$('#xferName').addEventListener('change', () => localStorage.setItem('xferName', $('#xferName').value));
$('#xferName').value = localStorage.getItem('xferName') || '';

$('#xferCreate').addEventListener('click', async () => {
  if (!(await requireAccess())) return;
  try {
    const d = await api('/api/transfer/rooms', { json: { name: ensureName() } });
    await enterRoom(d.code);
  } catch (e) { alert(e.message); }
});

$('#xferJoinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#xferCode').value.trim().toLowerCase();
  if (code.length >= 4) enterRoom(code).catch((err) => alert(err.message));
});

async function enterRoom(code) {
  if (!(await requireAccess())) return;
  if (xfer.room) await api(`/api/transfer/room/${xfer.room}/leave`, { json: { mid: xfer.me } }).catch(() => {});
  const d = await api(`/api/transfer/room/${encodeURIComponent(code)}/join`, { json: { name: ensureName() } });
  xfer.room = d.code;
  xfer.me = d.id;
  xfer.joinUrl = location.origin + '/?code=' + d.code;
  $('#xferSetup').hidden = true;
  $('#xferActive').hidden = false;
  $('#xferCode').value = '';
  $('#xferRoomCode').textContent = d.code.toUpperCase();
  $('#xferQr').src = '/qr?data=' + encodeURIComponent(xfer.joinUrl) + '&scale=5';
  $('#msgList').replaceChildren();
  $('#fileList').replaceChildren();
  $('#progList').replaceChildren();
  recvListEl().replaceChildren();
  startPoll();
}

function leaveRoom(reason) {
  clearInterval(xfer.pollTimer);
  xfer.pollTimer = null;
  if (xfer.room) api(`/api/transfer/room/${xfer.room}/leave`, { json: { mid: xfer.me } }).catch(() => {});
  xfer.room = null; xfer.me = ''; xfer.busy = false;
  $('#xferActive').hidden = true;
  $('#xferSetup').hidden = false;
  if (reason) alert(reason);
}
$('#xferLeave').addEventListener('click', () => leaveRoom());
$('#xferCopyInv').addEventListener('click', () => copyText(xfer.joinUrl, $('#xferCopyInv')));

function startPoll() {
  clearInterval(xfer.pollTimer);
  poll();
  xfer.pollTimer = setInterval(poll, 1500);
}

async function poll() {
  if (!xfer.room || !xfer.me) return;
  let st;
  try {
    st = await api(`/api/transfer/room/${encodeURIComponent(xfer.room)}?mid=${encodeURIComponent(xfer.me)}`);
  } catch (e) {
    leaveRoom('Комната недоступна: ' + e.message);
    return;
  }
  renderMembers(st);
  renderMessages(st);
  renderFiles(st);
  updateTargets(st);
  (st.inbox || []).forEach((sig) => {
    if (sig.type === 'offer') handleOffer(sig);
    else if (sig.type === 'answer') {
      const w = xfer.waitingAnswers.get(sig.from);
      if (w) { xfer.waitingAnswers.delete(sig.from); w(sig.payload && sig.payload.sdp); }
    }
  });
}

function renderMembers(st) {
  const box = $('#xferMembers');
  box.replaceChildren();
  st.members.forEach((m) => {
    const chip = el('span', 'chip' + (m.id === xfer.me ? ' me' : '') + (m.online ? '' : ' off'),
      m.name + (m.id === xfer.me ? ' (вы)' : '') + (m.online ? '' : ' · офлайн'));
    box.appendChild(chip);
  });
}

function renderMessages(st) {
  const box = $('#msgList');
  const key = st.messages.map((m) => m.id).join(',');
  if (key === xfer.lastMsgKey) return;
  xfer.lastMsgKey = key;
  box.replaceChildren();
  st.messages.forEach((m) => {
    const d = el('div', 'msg');
    d.appendChild(el('span', 'who', m.name));
    d.appendChild(document.createTextNode(m.text));
    d.appendChild(el('span', 'when', fmtTime(m.ts)));
    box.appendChild(d);
  });
  box.scrollTop = box.scrollHeight;
}

$('#msgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inp = $('#msgText');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  try {
    await api(`/api/transfer/room/${encodeURIComponent(xfer.room)}/message`, { json: { mid: xfer.me, text } });
    poll();
  } catch (err) { alert(err.message); }
});

function recvListEl() { return $('#recvList'); }

function renderFiles(st) {
  const list = $('#fileList');
  list.replaceChildren();
  if (!st.files.length) return;
  st.files.forEach((f) => {
    const item = el('div', 'item');
    item.appendChild(el('span', 'linkid', f.name.length > 42 ? f.name.slice(0, 39) + '…' : f.name));
    item.appendChild(el('span', 'fsize', fmtSize(f.size) + ' · ' + f.by + ' · ' + fmtTime(f.ts)));
    item.appendChild(el('span', 'grow'));
    item.appendChild(el('span', 'badge relay', 'сервер'));
    const a = el('a', 'btn ghost', 'Скачать');
    a.href = `/api/transfer/room/${encodeURIComponent(xfer.room)}/file/${encodeURIComponent(f.id)}`;
    a.setAttribute('download', f.name);
    item.appendChild(a);
    list.appendChild(item);
  });
}

function addRecvItem(name, url, size) {
  const item = el('div', 'item');
  item.appendChild(el('span', 'linkid', name.length > 42 ? name.slice(0, 39) + '…' : name));
  item.appendChild(el('span', 'fsize', fmtSize(size)));
  item.appendChild(el('span', 'grow'));
  item.appendChild(el('span', 'badge p2p', 'напрямую'));
  const a = el('a', 'btn ghost', 'Скачать');
  a.href = url; a.setAttribute('download', name);
  item.appendChild(a);
  recvListEl().appendChild(item);
}

function updateTargets(st) {
  const others = st.members.filter((m) => m.online && m.id !== xfer.me).map((m) => m.name);
  $('#fileTargets').textContent = others.length ? others.join(', ') : 'пока никого — файл уйдёт на сервер комнаты';
}

/* ---------- прогресс-строки ---------- */
function addProgressRow(label) {
  const row = el('div', 'prog');
  const prow = el('div', 'prow');
  const lab = el('span', null, label);
  const status = el('span', 'meta', '0%');
  prow.appendChild(lab); prow.appendChild(status);
  const track = el('div', 'track');
  const fill = el('div', 'fill');
  track.appendChild(fill);
  row.appendChild(prow); row.appendChild(track);
  $('#progList').appendChild(row);
  return {
    setPct(p) { fill.style.width = Math.round(p * 100) + '%'; status.textContent = Math.round(p * 100) + '%'; },
    done(text) { fill.style.width = '100%'; row.classList.add('done'); status.textContent = text || 'готово'; },
    fail(text) { row.classList.add('fail'); status.textContent = text || 'ошибка'; },
  };
}

/* ---------- загрузка на сервер (fallback) ---------- */
function uploadXHR(room, file, mid, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('mid', mid);
    fd.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/transfer/room/${encodeURIComponent(room)}/upload`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText || '{}')); } catch (e) { resolve({}); } }
      else { let msg = 'HTTP ' + xhr.status; try { msg = (JSON.parse(xhr.responseText) || {}).error || msg; } catch (e) {} reject(new Error(msg)); }
    };
    xhr.onerror = () => reject(new Error('Сеть недоступна'));
    xhr.send(fd);
  });
}

/* ---------- WebRTC ---------- */
const STUN = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

function gatherPC(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(done, 2500);
    function on() { if (pc.iceGatheringState === 'complete') done(); }
    function done() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', on); resolve(); }
    pc.addEventListener('icegatheringstatechange', on);
  });
}

function sendFileOverDC(dc, file, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      dc.bufferedAmountLowThreshold = 512 * 1024;
      dc.send(JSON.stringify({ t: 'f', name: file.name, size: file.size, mime: file.type || 'application/octet-stream' }));
      const CHUNK = 64 * 1024;
      let offset = 0;
      while (offset < file.size) {
        if (dc.readyState !== 'open') throw new Error('канал закрылся');
        if (dc.bufferedAmount > 4 * 1024 * 1024) await drained(dc);
        const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
        dc.send(buf);
        offset += buf.byteLength;
        if (onProgress) onProgress(offset / file.size);
        await new Promise((r) => setTimeout(r, 0));
      }
      dc.send(JSON.stringify({ t: 'e' }));
      resolve();
    } catch (e) { reject(e); }
  });
}

function drained(dc) {
  return new Promise((resolve) => {
    if (dc.bufferedAmount <= dc.bufferedAmountLowThreshold) return resolve();
    const h = () => {
      if (dc.bufferedAmount <= dc.bufferedAmountLowThreshold) {
        dc.removeEventListener('bufferedamountlow', h);
        resolve();
      }
    };
    dc.addEventListener('bufferedamountlow', h);
  });
}

function p2pAttempt(peer, file, onProgress) {
  return new Promise((resolveOuter) => {
    let finished = false;
    let pc = null;
    const kill = setTimeout(() => finish(false), 30000);
    function finish(v) {
      if (finished) return;
      finished = true;
      clearTimeout(kill);
      try { if (pc) pc.close(); } catch (e) {}
      resolveOuter(v);
    }
    (async () => {
      pc = new RTCPeerConnection(STUN);
      const dc = pc.createDataChannel('file');
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => {
        sendFileOverDC(dc, file, onProgress).then(() => finish(true)).catch(() => finish(false));
      };
      const answerPromise = new Promise((res) => xfer.waitingAnswers.set(peer.id, res));
      await pc.setLocalDescription(await pc.createOffer());
      await gatherPC(pc);
      await api(`/api/transfer/room/${encodeURIComponent(xfer.room)}/signal`, {
        json: { from: xfer.me, target: peer.id, type: 'offer', payload: { sdp: pc.localDescription.sdp } },
      });
      const sdp = await answerPromise;
      await pc.setRemoteDescription({ type: 'answer', sdp });
      /* успех определится по dc.onopen; общий таймаут 30 с подстрахует */
    })().catch(() => finish(false));
  });
}

async function handleOffer(sig) {
  let pc;
  try {
    pc = new RTCPeerConnection(STUN);
    pc.ondatachannel = (e) => setupRecvChannel(e.channel);
    await pc.setRemoteDescription({ type: 'offer', sdp: sig.payload.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gatherPC(pc);
    await api(`/api/transfer/room/${encodeURIComponent(xfer.room)}/signal`, {
      json: { from: xfer.me, target: sig.from, type: 'answer', payload: { sdp: pc.localDescription.sdp } },
    });
    setTimeout(() => { try { pc.close(); } catch (e) {} }, 120000);
  } catch (e) {
    try { if (pc) pc.close(); } catch (e2) {}
  }
}

function setupRecvChannel(dc) {
  dc.binaryType = 'arraybuffer';
  let inc = null;
  dc.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let j;
      try { j = JSON.parse(e.data); } catch (err) { return; }
      if (j.t === 'f') {
        inc = {
          name: j.name || 'file', size: j.size || 0,
          mime: j.mime || 'application/octet-stream',
          parts: [], received: 0,
          row: addProgressRow('← ' + (j.name || 'file')),
        };
      } else if (j.t === 'e' && inc) {
        const blob = new Blob(inc.parts, { type: inc.mime });
        inc.row.done('принято, ' + fmtSize(blob.size));
        addRecvItem(inc.name, URL.createObjectURL(blob), blob.size);
        inc = null;
      }
    } else if (inc) {
      inc.parts.push(e.data);
      inc.received += e.data.byteLength;
      if (inc.size) inc.row.setPct(inc.received / inc.size);
    }
  };
}

/* ---------- файлы: выбор и drag&drop ---------- */
$('#fileBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  if (e.target.files.length) sendFiles(e.target.files);
  e.target.value = '';
});
const dz = $('#dropZone');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('drag');
  if (e.dataTransfer.files.length) sendFiles(e.dataTransfer.files);
});

async function sendFiles(fileList) {
  if (!xfer.room || xfer.busy) return;
  const files = Array.from(fileList);
  xfer.busy = true;
  try {
    const st = await api(`/api/transfer/room/${encodeURIComponent(xfer.room)}?mid=${encodeURIComponent(xfer.me)}`);
    const targets = st.members.filter((m) => m.online && m.id !== xfer.me);
    for (const f of files) {
      let anyFallback = false;
      for (const t of targets) {
        const r = addProgressRow(f.name + ' → ' + t.name);
        const ok = await p2pAttempt(t, f, (p) => r.setPct(p));
        if (ok) r.done('передано напрямую (P2P)');
        else { anyFallback = true; r.fail('напрямую не удалось — будет через сервер'); }
      }
      if (anyFallback || !targets.length) {
        const r = addProgressRow(f.name + ' → сервер комнаты');
        try {
          await uploadXHR(xfer.room, f, xfer.me, (p) => r.setPct(p));
          r.done('опубликовано для всех (сервер)');
        } catch (e) {
          r.fail(e.message);
        }
      }
    }
    poll();
  } finally {
    xfer.busy = false;
  }
}

/* ---------- доступ ---------- */
let authPromptResolve = null;

async function refreshState() {
  try {
    authState = await api('/api/auth/state');
  } catch (e) { /* оставляем прежнее состояние */ }
  renderAuthTab();
  return authState;
}

async function finishLock(ok) {
  $('#lock').hidden = true;
  const r = authPromptResolve;
  authPromptResolve = null;
  if (ok) await refreshState();
  if (r) r(!!ok);
}

function promptLogin() {
  if (authState.trusted) return Promise.resolve(true);
  return new Promise((resolve) => {
    if (authPromptResolve) {
      const prev = authPromptResolve;
      authPromptResolve = (ok) => { prev(ok); resolve(ok); };
      return;
    }
    authPromptResolve = resolve;
    renderLock();
  });
}

function requireAccess() {
  if (!authState.protect || authState.trusted) return Promise.resolve(true);
  return promptLogin();
}

function requireLogin() {
  if (authState.trusted) return Promise.resolve(true);
  return promptLogin();
}

function renderLock() {
  const lock = $('#lock');
  const card = $('#lockCard');
  lock.hidden = false;
  card.replaceChildren();

  card.appendChild(el('h1', null, '🔒 Защищено'));
  card.appendChild(el('div', 'lockhint', 'QR-коды и комнаты передачи защищены. Войдите, чтобы продолжить.'));

  const err = el('div', 'lockerr');
  card.appendChild(err);

  const nameInp = document.createElement('input');
  nameInp.placeholder = 'Имя этого устройства (необязательно)';
  nameInp.value = localStorage.getItem('xferName') || '';
  card.appendChild(nameInp);

  const doLogin = async (method, value) => {
    try {
      await api('/api/auth/login', { json: { method, value, name: nameInp.value || undefined } });
      finishLock(true);
    } catch (e) { err.textContent = e.message; }
  };

  const doRedeem = async (code) => {
    try {
      await api('/api/auth/redeem', { json: { code, name: nameInp.value || 'По приглашению' } });
      finishLock(true);
    } catch (e) { err.textContent = e.message; }
  };

  if (authState.methods && authState.methods.password) {
    const p = document.createElement('input');
    p.type = 'password'; p.placeholder = 'Мастер-пароль';
    const b = el('button', 'btn primary', 'Войти');
    b.addEventListener('click', () => doLogin('password', p.value));
    p.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin('password', p.value); });
    card.appendChild(p); card.appendChild(b);
  }

  if (authState.methods && authState.methods.pin) {
    const p = document.createElement('input');
    p.inputMode = 'numeric'; p.placeholder = 'PIN-код';
    const b = el('button', 'btn', 'Войти по PIN');
    b.addEventListener('click', () => doLogin('pin', p.value.trim()));
    card.appendChild(p); card.appendChild(b);
  }

  if (authState.methods && authState.methods.approval) {
    if (authState.methods.password || authState.methods.pin) card.appendChild(el('div', 'lockhint', 'или'));
    const b = el('button', 'btn', 'Запросить доступ с доверенного устройства');
    b.addEventListener('click', () => approveFlow(nameInp.value, err));
    card.appendChild(b);
  }

  const row = el('div', 'row');
  const codeInp = document.createElement('input');
  codeInp.placeholder = 'Код-приглашение';
  const codeBtn = el('button', 'btn', 'По коду');
  codeBtn.addEventListener('click', () => doRedeem(codeInp.value.trim()));
  row.appendChild(codeInp); row.appendChild(codeBtn);
  card.appendChild(row);

  const cancel = el('button', 'btn ghost', 'Отмена');
  cancel.addEventListener('click', () => finishLock(false));
  card.appendChild(cancel);
}

async function approveFlow(name, err) {
  try {
    const r = await api('/api/auth/request', { json: { name: name || 'Новое устройство' } });
    const box = el('div', 'item');
    box.appendChild(el('span', 'spinner'));
    box.appendChild(el('span', null, 'Ожидает подтверждения… Откройте «Доступ» на доверенном устройстве.'));
    $('#lockCard').appendChild(box);
    const timer = setInterval(async () => {
      try {
        const c = await api('/api/auth/claim', { json: { reqId: r.reqId } });
        if (c.status === 'approved') { clearInterval(timer); finishLock(true); }
        else if (c.status === 'denied') { clearInterval(timer); box.remove(); err.textContent = 'Запрос отклонён'; }
        else if (c.status === 'expired') { clearInterval(timer); box.remove(); err.textContent = 'Запрос истёк — попробуйте снова'; }
      } catch (e) { /* продолжаем ждать */ }
    }, 2000);
  } catch (e) { err.textContent = e.message; }
}

/* вкладка «Доступ» */
function renderAuthTab() {
  if (!$('#authProtect')) return;
  const hasPass = !!(authState.methods && authState.methods.password);
  $('#authProtect').checked = !!authState.protect;
  $('#protectSetup').hidden = hasPass;
  $('#authManage').hidden = !authState.trusted;
  $('#authLocked').hidden = !hasPass || authState.trusted;

  if (!hasPass) {
    $('#authSelf').textContent = 'Защита не настроена: QR и комнаты открыты.';
  } else if (authState.trusted) {
    $('#authSelf').textContent = 'Это устройство: ' + (authState.me ? authState.me.name : '—') + ' · доверенное';
  } else {
    $('#authSelf').textContent = 'Вы не вошли на этом устройстве.';
  }

  $('#authProtectMsg').textContent = authState.protect
    ? 'Включено: QR-коды и комнаты требуют вход. Ссылки и главная страница открыты.'
    : 'Выключено: QR-коды и комнаты доступны без входа.';
}

async function refreshAuthLive() {
  await refreshState();
  if (!authState.trusted) return;
  try {
    const o = await api('/api/auth/overview');
    $('#authApproval').checked = !!o.approval;
    $('#authPinState').textContent = o.pin ? 'PIN включён' : 'PIN выключен';
    $('#pendingCount').textContent = o.pending.length ? String(o.pending.length) : '';

    const pl = $('#pendingList');
    pl.replaceChildren();
    if (!o.pending.length) pl.appendChild(el('div', 'item muted', 'Новых запросов нет.'));
    o.pending.forEach((r) => {
      const it = el('div', 'item');
      it.appendChild(el('span', 'linkid', r.name));
      it.appendChild(el('span', 'meta', '· ' + (r.ua || '').slice(0, 60) + ' · ' + fmtTime(r.ts)));
      it.appendChild(el('span', 'grow'));
      const ok = el('button', 'btn', 'Разрешить');
      ok.addEventListener('click', async () => {
        try { await api('/api/auth/pending/' + r.id + '/approve', { json: {} }); refreshAuthLive(); } catch (e) {}
      });
      const no = el('button', 'btn ghost danger', 'Отклонить');
      no.addEventListener('click', async () => {
        try { await api('/api/auth/pending/' + r.id + '/deny', { json: {} }); refreshAuthLive(); } catch (e) {}
      });
      it.appendChild(ok); it.appendChild(no);
      pl.appendChild(it);
    });

    const dl = $('#deviceList');
    dl.replaceChildren();
    o.devices.forEach((d) => {
      const it = el('div', 'item');
      it.appendChild(el('span', 'linkid', d.name));
      it.appendChild(el('span', 'meta', '· актив. ' + fmtDate(d.lastSeen)));
      if (o.me && d.id === o.me.id) it.appendChild(el('span', 'badge', 'это устройство'));
      it.appendChild(el('span', 'grow'));
      const rv = el('button', 'btn ghost danger', 'Отключить');
      rv.addEventListener('click', async () => {
        if (!confirm('Отключить устройство «' + d.name + '»?')) return;
        try {
          await api('/api/auth/devices/' + d.id + '/revoke', { json: {} });
          if (o.me && d.id === o.me.id) location.reload(); else refreshAuthLive();
        } catch (e) {}
      });
      it.appendChild(rv);
      dl.appendChild(it);
    });

    const il = $('#inviteList');
    il.replaceChildren();
    if (!o.invites.length) il.appendChild(el('div', 'item muted', 'Активных приглашений нет.'));
    o.invites.forEach((i) => {
      const left = Math.max(1, Math.round((10 * 60 * 1000 - (Date.now() - i.ts)) / 60000));
      const it = el('div', 'item');
      it.appendChild(el('span', 'linkid', i.code));
      it.appendChild(el('span', 'meta', '· ещё ~' + left + ' мин'));
      it.appendChild(el('span', 'grow'));
      const qr = el('button', 'btn ghost', 'QR');
      qr.addEventListener('click', () => showQr(i.url, 'Приглашение (одноразовое)'));
      const cp = el('button', 'btn ghost', 'Копировать');
      cp.addEventListener('click', () => copyText(i.url, cp));
      const rv = el('button', 'btn ghost danger', '✕');
      rv.addEventListener('click', async () => {
        try { await api('/api/auth/invites/' + i.code, { method: 'DELETE' }); refreshAuthLive(); } catch (e) {}
      });
      it.appendChild(qr); it.appendChild(cp); it.appendChild(rv);
      il.appendChild(it);
    });
  } catch (e) {
    if (String(e.message || '').includes('Требуется вход')) {
      authState.trusted = false;
      renderAuthTab();
    }
  }
}

/* защита QR и комнат */
async function setProtection(want) {
  await api('/api/auth/config', { json: { protect: want } });
  await refreshAuthLive();
}

$('#authProtect').addEventListener('change', async (e) => {
  const want = e.target.checked;
  if (!(authState.methods && authState.methods.password)) {
    e.target.checked = false;
    $('#protectSetup').hidden = false;
    $('#protectPass').focus();
    return;
  }
  if (!authState.trusted) {
    e.target.checked = !want;
    if (!(await requireLogin())) return;
  }
  try { await setProtection(want); }
  catch (err) { e.target.checked = !want; $('#authProtectMsg').textContent = err.message; }
});

$('#protectEnable').addEventListener('click', async () => {
  const v = $('#protectPass').value;
  if (v.length < 6) { $('#authProtectMsg').textContent = 'Пароль минимум 6 символов'; return; }
  try {
    await api('/api/auth/setup', { json: { pass: v, protect: true, name: localStorage.getItem('xferName') || 'Моё устройство' } });
    $('#protectPass').value = '';
    await refreshAuthLive();
  } catch (e) { $('#authProtectMsg').textContent = e.message; }
});

$('#authLoginBtn').addEventListener('click', async () => {
  if (await requireLogin()) refreshAuthLive();
});

$('#authApproval').addEventListener('change', async (e) => {
  try { await api('/api/auth/config', { json: { approval: e.target.checked } }); refreshAuthLive(); }
  catch (err) { e.target.checked = !e.target.checked; }
});
$('#authPassSave').addEventListener('click', async () => {
  const v = $('#authPassNew').value;
  const msg = $('#authPassMsg');
  try {
    await api('/api/auth/config', { json: { password: { value: v } } });
    $('#authPassNew').value = '';
    msg.textContent = 'Пароль обновлён';
  } catch (e) { msg.textContent = e.message; }
});
$('#authPinSave').addEventListener('click', async () => {
  try {
    await api('/api/auth/config', { json: { pin: { value: $('#authPinVal').value.trim() } } });
    $('#authPinVal').value = '';
    refreshAuthLive();
  } catch (e) { $('#authPinState').textContent = e.message; }
});
$('#authPinOff').addEventListener('click', async () => {
  try { await api('/api/auth/config', { json: { pin: { set: false } } }); refreshAuthLive(); } catch (e) {}
});
$('#authInvite').addEventListener('click', async () => {
  try {
    const d = await api('/api/auth/invites', { json: {} });
    showQr(d.url, 'Одноразовое приглашение (10 минут)');
    refreshAuthLive();
  } catch (e) { alert(e.message); }
});
$('#authLeave').addEventListener('click', async () => {
  if (!confirm('Выйти из доверенных на этом устройстве?')) return;
  try { await api('/api/auth/leave', { json: {} }); location.reload(); } catch (e) { alert(e.message); }
});

/* ---------- старт ---------- */
async function boot() {
  await refreshState();

  const params = new URLSearchParams(location.search);
  const authCode = params.get('auth');
  if (authCode) {
    history.replaceState(null, '', '/');
    try {
      await api('/api/auth/redeem', { json: { code: authCode, name: localStorage.getItem('xferName') || 'По приглашению' } });
      await refreshState();
    } catch (e) { /* неверный или истёкший код — просто открываем сайт */ }
  }

  const invited = params.get('code') || sessionStorage.getItem('pendingRoom');
  sessionStorage.removeItem('pendingRoom');
  if (invited) {
    history.replaceState(null, '', '/');
    showTab('xfer');
    $('#xferCode').value = invited;
    enterRoom(String(invited).toLowerCase()).catch(() => {});
  }

  loadLinks();
  refreshAuthLive().catch(() => {});
  setInterval(() => {
    if (!document.hidden && $('#view-auth').classList.contains('active')) refreshAuthLive();
  }, 5000);
}

boot();
