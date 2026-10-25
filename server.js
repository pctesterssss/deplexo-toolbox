'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const multer = require('multer');

const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const ROOM_IDLE_MS = 30 * 60 * 1000;
const MEMBER_ONLINE_MS = 40 * 1000;
const INVITE_TTL_MS = 10 * 60 * 1000;   // одноразовая ссылка-приглашение
const REQUEST_TTL_MS = 10 * 60 * 1000;  // запрос на подтверждение с устройства
const COOKIE_MAX_MS = 365 * 24 * 3600 * 1000;

// ---------- диск ----------
const UPLOAD_DIR = path.join(os.tmpdir(), 'toolbox-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DATA_DIR = (() => {
  for (const d of ['/data', path.join(__dirname, 'local-data')]) {
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      return d;
    } catch (e) { /* пробуем следующий вариант */ }
  }
  return os.tmpdir();
})();
const LINKS_FILE = path.join(DATA_DIR, 'links.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

let links = [];
try { links = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); } catch (e) { links = []; }

let saveTimer = null;
function saveLinks() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(LINKS_FILE, JSON.stringify(links)); } catch (e) { /* ignore */ }
  }, 300);
}

// ---------- утилиты ----------
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function randCode(n) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

function sanitizeName(raw) {
  const s = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
  return s || 'Устройство';
}

function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  return `${req.protocol}://${req.get('host')}`;
}

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function hashWithSalt(value, salt) { return sha(salt + '|' + value); }
function makeSecret() { return crypto.randomBytes(24).toString('base64url'); }

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) {
      const k = p.slice(0, i).trim();
      let v = p.slice(i + 1).trim();
      try { v = decodeURIComponent(v); } catch (e) { /* оставить как есть */ }
      out[k] = v;
    }
  });
  return out;
}

// ---------- контроль доступа ----------
let auth = { admin: null, pin: null, approval: false, devices: [], invites: [], requests: [] };
try {
  const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  auth = Object.assign(auth, raw);
  if (!Array.isArray(auth.devices)) auth.devices = [];
  if (!Array.isArray(auth.invites)) auth.invites = [];
  if (!Array.isArray(auth.requests)) auth.requests = [];
} catch (e) { /* первая настройка */ }

let authSaveTimer = null;
function saveAuth() {
  clearTimeout(authSaveTimer);
  authSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(AUTH_FILE, JSON.stringify(auth)); } catch (e) { /* ignore */ }
  }, 250);
}

function setAdminPass(value) {
  const salt = crypto.randomBytes(16).toString('hex');
  auth.admin = { salt, hash: hashWithSalt(String(value), salt) };
  saveAuth();
}

if (process.env.TOOLBOX_ADMIN_PASS && !auth.admin) {
  setAdminPass(process.env.TOOLBOX_ADMIN_PASS);
  console.log('auth: admin password initialized from TOOLBOX_ADMIN_PASS');
}

function pruneAuth() {
  const now = Date.now();
  auth.invites = auth.invites.filter((i) => now - i.ts < INVITE_TTL_MS);
  for (const r of auth.requests) {
    if (r.status === 'pending' && now - r.ts > REQUEST_TTL_MS) r.status = 'expired';
  }
  if (auth.requests.length > 100) auth.requests = auth.requests.slice(-100);
}

function ensureDevId(req, res) {
  const c = parseCookies(req);
  if (c.tb_dev) return c.tb_dev;
  const id = randCode(12);
  res.cookie('tb_dev', id, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_MS, path: '/' });
  return id;
}

function currentDevice(req) {
  const c = parseCookies(req);
  if (!c.tb_dev || !c.tb_tok) return null;
  const d = auth.devices.find((x) => x.id === c.tb_dev);
  if (!d) return null;
  if (d.tok !== sha(c.tb_tok)) return null;
  d.lastSeen = Date.now();
  return d;
}

function issueDevice(res, devId, name) {
  const token = makeSecret();
  const dev = {
    id: devId || randCode(12),
    name: sanitizeName(name || 'Устройство'),
    tok: sha(token),
    added: Date.now(),
    lastSeen: Date.now(),
  };
  auth.devices = auth.devices.filter((d) => d.id !== dev.id);
  auth.devices.push(dev);
  if (auth.devices.length > 50) auth.devices.splice(0, auth.devices.length - 50);
  saveAuth();
  res.cookie('tb_dev', dev.id, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_MS, path: '/' });
  res.cookie('tb_tok', token, { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_MS, path: '/' });
  return dev;
}

function overviewPayload(req) {
  pruneAuth();
  const me = currentDevice(req);
  return {
    me: me ? { id: me.id, name: me.name } : null,
    devices: auth.devices
      .map((d) => ({ id: d.id, name: d.name, added: d.added, lastSeen: d.lastSeen }))
      .sort((a, b) => b.lastSeen - a.lastSeen),
    pending: auth.requests
      .filter((r) => r.status === 'pending')
      .map((r) => ({ id: r.id, name: r.name, ua: r.ua, ts: r.ts })),
    invites: auth.invites.map((i) => ({ code: i.code, ts: i.ts, url: `${baseUrl(req)}/?auth=${i.code}` })),
    approval: !!auth.approval,
    pin: !!auth.pin,
    admin: !!auth.admin,
  };
}

// ---------- короткие ссылки ----------
function publicFile(rec) {
  return { id: rec.id, name: rec.name, size: rec.size, by: rec.by, ts: rec.ts };
}

// ---------- комнаты передачи ----------
const rooms = new Map();

function touchRoom(room) {
  room.lastActivity = Date.now();
  room.expiresAt = room.lastActivity + ROOM_TTL_MS;
}

function createRoom() {
  let code;
  do { code = randCode(6); } while (rooms.has(code));
  const room = {
    code,
    created: Date.now(),
    lastActivity: Date.now(),
    expiresAt: Date.now() + ROOM_TTL_MS,
    members: new Map(),
    messages: [],
    files: new Map(),
    inboxes: new Map(),
  };
  rooms.set(code, room);
  return room;
}

function destroyRoom(room) {
  rooms.delete(room.code);
  for (const f of room.files.values()) {
    try { fs.unlinkSync(f.path); } catch (e) { /* уже удалён */ }
  }
}

function sweep() {
  const now = Date.now();
  for (const room of Array.from(rooms.values())) {
    const online = Array.from(room.members.values()).some((m) => now - m.lastSeen < MEMBER_ONLINE_MS);
    if (now > room.expiresAt || (!online && now - room.lastActivity > ROOM_IDLE_MS)) destroyRoom(room);
  }
}
setInterval(sweep, 60 * 1000).unref();

// ---------- приложение ----------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== публичные маршруты =====
app.get('/healthz', (req, res) => res.json({ ok: true, links: links.length, rooms: rooms.size }));

app.get('/qr', async (req, res) => {
  const data = String(req.query.data || '').slice(0, 2000);
  if (!data) return res.status(400).json({ error: 'Нет data' });
  const scale = Math.min(Math.max(parseInt(req.query.scale, 10) || 6, 2), 12);
  try {
    const buf = await QRCode.toBuffer(data, {
      scale,
      margin: 2,
      color: { dark: '#111418', light: '#ffffff' },
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    res.status(400).json({ error: 'Данные слишком длинные или некорректные' });
  }
});

const PAGE_404 = '<!doctype html><meta charset="utf-8"><title>404</title>' +
  '<body style="font-family:system-ui;background:#0e1013;color:#e6e9ef;display:flex;min-height:90vh;align-items:center;justify-content:center;flex-direction:column;gap:12px">' +
  '<div style="font-size:22px">Ссылка не найдена.</div>' +
  '<a style="color:#4f8cff" href="/">На главную</a></body>';

app.get('/s/:id', (req, res) => {
  const link = links.find((l) => l.id === req.params.id);
  if (!link) return res.status(404).send(PAGE_404);
  link.clicks++;
  saveLinks();
  res.redirect(302, link.url);
});

// ===== публичные auth-маршруты =====
app.get('/api/auth/state', (req, res) => {
  const devId = ensureDevId(req, res);
  pruneAuth();
  const dev = currentDevice(req);
  res.json({
    needsSetup: !auth.admin && auth.devices.length === 0,
    trusted: !!dev,
    me: dev ? { id: dev.id, name: dev.name } : null,
    devId,
    methods: { password: !!auth.admin, pin: !!auth.pin, approval: !!auth.approval },
    trustedCount: auth.devices.length,
  });
});

app.post('/api/auth/setup', (req, res) => {
  if (auth.admin || auth.devices.length) return res.status(403).json({ error: 'Уже настроено' });
  const pass = String((req.body && req.body.pass) || '');
  if (pass.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
  setAdminPass(pass);
  const devId = ensureDevId(req, res);
  const dev = issueDevice(res, devId, (req.body && req.body.name) || 'Моё устройство');
  res.json({ ok: true, me: { id: dev.id, name: dev.name } });
});

const loginHits = new Map();
app.post('/api/auth/login', (req, res) => {
  const ip = String(req.ip || 'x');
  const rec = loginHits.get(ip) || { n: 0, ts: Date.now() };
  if (Date.now() - rec.ts > 60000) { rec.n = 0; rec.ts = Date.now(); }
  if (rec.n >= 12) return res.status(429).json({ error: 'Слишком много попыток. Подождите минуту.' });
  rec.n++;
  loginHits.set(ip, rec);

  const method = String((req.body && req.body.method) || 'password');
  const value = String((req.body && req.body.value) || '');
  let ok = false;
  if (method === 'password' && auth.admin && value) {
    ok = hashWithSalt(value, auth.admin.salt) === auth.admin.hash;
  } else if (method === 'pin' && auth.pin && value) {
    ok = hashWithSalt(value, auth.pin.salt) === auth.pin.hash;
  }
  if (!ok) return res.status(401).json({ error: 'Неверный пароль' });

  rec.n = 0;
  const devId = ensureDevId(req, res);
  const dev = issueDevice(res, devId, (req.body && req.body.name) || 'Устройство');
  res.json({ ok: true, me: { id: dev.id, name: dev.name } });
});

app.post('/api/auth/request', (req, res) => {
  if (!auth.approval) return res.status(400).json({ error: 'Подтверждение новых устройств выключено' });
  pruneAuth();
  if (auth.requests.filter((r) => r.status === 'pending').length >= 10) {
    return res.status(429).json({ error: 'Слишком много запросов, попробуйте позже' });
  }
  const devId = ensureDevId(req, res);
  if (auth.devices.some((d) => d.id === devId)) return res.status(400).json({ error: 'Устройство уже доверено' });
  const id = randCode(10);
  auth.requests.push({
    id,
    devId,
    name: sanitizeName((req.body && req.body.name) || 'Новое устройство'),
    ua: String(req.get('user-agent') || '').slice(0, 120),
    ts: Date.now(),
    status: 'pending',
    redeemed: false,
  });
  saveAuth();
  res.json({ reqId: id });
});

app.post('/api/auth/claim', (req, res) => {
  pruneAuth();
  const devId = parseCookies(req).tb_dev;
  const r = auth.requests.find((x) => x.id === String((req.body && req.body.reqId) || ''));
  if (!r || r.devId !== devId) return res.status(404).json({ error: 'Запрос не найден' });
  if (r.status === 'denied') return res.json({ status: 'denied' });
  if (r.status !== 'approved') {
    const expired = Date.now() - r.ts > REQUEST_TTL_MS;
    if (expired) { r.status = 'expired'; saveAuth(); }
    return res.json({ status: expired ? 'expired' : 'pending' });
  }
  if (r.redeemed) return res.json({ status: 'expired' });
  r.redeemed = true;
  saveAuth();
  const dev = issueDevice(res, devId, r.name);
  res.json({ status: 'approved', me: { id: dev.id, name: dev.name } });
});

app.post('/api/auth/redeem', (req, res) => {
  pruneAuth();
  const code = String((req.body && req.body.code) || '').trim().toLowerCase();
  const i = auth.invites.findIndex((x) => x.code === code);
  if (i < 0) return res.status(404).json({ error: 'Код не найден или истёк' });
  auth.invites.splice(i, 1);
  saveAuth();
  const devId = ensureDevId(req, res);
  const dev = issueDevice(res, devId, (req.body && req.body.name) || 'По приглашению');
  res.json({ ok: true, me: { id: dev.id, name: dev.name } });
});

// ===== шлюз: всё остальное под /api требует доверенного устройства =====
app.use('/api', (req, res, next) => {
  if (currentDevice(req)) return next();
  res.status(401).json({ error: 'Требуется вход', code: 'auth' });
});

// ===== auth-маршруты доверенных устройств =====
app.get('/api/auth/overview', (req, res) => {
  res.json(overviewPayload(req));
});

app.post('/api/auth/config', (req, res) => {
  const b = req.body || {};
  if (typeof b.approval === 'boolean') auth.approval = b.approval;
  if (b.pin) {
    if (b.pin.set === false) {
      auth.pin = null;
    } else {
      const v = String(b.pin.value || '');
      if (!/^\d{4,12}$/.test(v)) return res.status(400).json({ error: 'PIN: 4–12 цифр' });
      const salt = crypto.randomBytes(16).toString('hex');
      auth.pin = { salt, hash: hashWithSalt(v, salt) };
    }
  }
  if (b.password && b.password.value) {
    const v = String(b.password.value);
    if (v.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    setAdminPass(v);
  }
  saveAuth();
  res.json({ ok: true, overview: overviewPayload(req) });
});

app.post('/api/auth/pending/:id/approve', (req, res) => {
  pruneAuth();
  const r = auth.requests.find((x) => x.id === req.params.id);
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'Запрос не найден' });
  r.status = 'approved';
  saveAuth();
  res.json({ ok: true });
});

app.post('/api/auth/pending/:id/deny', (req, res) => {
  pruneAuth();
  const r = auth.requests.find((x) => x.id === req.params.id);
  if (!r || r.status !== 'pending') return res.status(404).json({ error: 'Запрос не найден' });
  r.status = 'denied';
  saveAuth();
  res.json({ ok: true });
});

app.post('/api/auth/devices/:id/revoke', (req, res) => {
  const me = currentDevice(req);
  if (!me) return res.status(401).json({ error: 'auth' });
  auth.devices = auth.devices.filter((d) => d.id !== req.params.id);
  saveAuth();
  if (req.params.id === me.id) {
    res.clearCookie('tb_tok', { path: '/' });
    res.clearCookie('tb_dev', { path: '/' });
  }
  res.json({ ok: true });
});

app.post('/api/auth/leave', (req, res) => {
  const me = currentDevice(req);
  if (me) {
    auth.devices = auth.devices.filter((d) => d.id !== me.id);
    saveAuth();
  }
  res.clearCookie('tb_tok', { path: '/' });
  res.clearCookie('tb_dev', { path: '/' });
  res.json({ ok: true });
});

app.post('/api/auth/invites', (req, res) => {
  pruneAuth();
  if (auth.invites.length >= 20) return res.status(429).json({ error: 'Слишком много активных приглашений' });
  const code = randCode(8);
  auth.invites.push({ code, ts: Date.now() });
  saveAuth();
  res.json({ code, url: `${baseUrl(req)}/?auth=${code}`, ttlMin: INVITE_TTL_MS / 60000 });
});

app.delete('/api/auth/invites/:code', (req, res) => {
  auth.invites = auth.invites.filter((i) => i.code !== req.params.code);
  saveAuth();
  res.json({ ok: true });
});

// ===== короткие ссылки =====
app.post('/api/shorten', (req, res) => {
  let u;
  try { u = new URL(String((req.body && req.body.url) || '')); } catch (e) {
    return res.status(400).json({ error: 'Некорректный URL' });
  }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'Только http(s) URL' });
  let id;
  do { id = randCode(6); } while (links.some((l) => l.id === id));
  const link = { id, url: u.toString(), created: Date.now(), clicks: 0 };
  links.unshift(link);
  saveLinks();
  res.json({ id, short: `${baseUrl(req)}/s/${id}` });
});

app.get('/api/links', (req, res) => res.json({ links }));

app.delete('/api/links/:id', (req, res) => {
  const i = links.findIndex((l) => l.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Нет такой ссылки' });
  links.splice(i, 1);
  saveLinks();
  res.json({ ok: true });
});

// ===== комнаты =====
app.post('/api/transfer/rooms', (req, res) => {
  const room = createRoom();
  res.json({ code: room.code, expiresAt: room.expiresAt, joinUrl: `${baseUrl(req)}/?code=${room.code}` });
});

app.post('/api/transfer/room/:code/join', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Комната не найдена или срок истёк' });
  const name = sanitizeName(req.body && req.body.name);
  const id = randCode(10);
  room.members.set(id, { id, name, lastSeen: Date.now() });
  touchRoom(room);
  res.json({ id, name, code: room.code });
});

app.post('/api/transfer/room/:code/leave', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.json({ ok: true });
  room.members.delete(String(req.body && req.body.mid));
  touchRoom(room);
  res.json({ ok: true });
});

app.get('/api/transfer/room/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Комната не найдена или срок истёк' });
  const mid = String(req.query.mid || '');
  const now = Date.now();
  const me = room.members.get(mid);
  if (me) me.lastSeen = now;
  const members = Array.from(room.members.values()).map((m) => ({
    id: m.id,
    name: m.name,
    online: now - m.lastSeen < MEMBER_ONLINE_MS,
  }));
  const inbox = room.inboxes.get(mid) || [];
  room.inboxes.set(mid, []);
  res.json({
    code: room.code,
    me: mid,
    members,
    messages: room.messages.slice(-100),
    files: Array.from(room.files.values()).map(publicFile),
    inbox,
  });
});

app.post('/api/transfer/room/:code/message', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Комната не найдена или срок истёк' });
  const mid = String((req.body && req.body.mid) || '');
  const mem = room.members.get(mid);
  if (!mem) return res.status(403).json({ error: 'Сначала присоединитесь к комнате' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  room.messages.push({ id: randCode(8), name: mem.name, text, ts: Date.now() });
  if (room.messages.length > 300) room.messages.splice(0, room.messages.length - 300);
  touchRoom(room);
  res.json({ ok: true });
});

app.post('/api/transfer/room/:code/signal', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Комната не найдена или срок истёк' });
  const { from, target, type, payload } = req.body || {};
  if (!['offer', 'answer'].includes(type)) return res.status(400).json({ error: 'bad type' });
  if (!room.members.has(String(target)) || payload == null) {
    return res.status(400).json({ error: 'bad signal' });
  }
  const box = room.inboxes.get(String(target)) || [];
  box.push({ from: String(from || ''), type, payload });
  if (box.length > 40) box.splice(0, box.length - 40);
  room.inboxes.set(String(target), box);
  touchRoom(room);
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, Date.now().toString(36) + '-' + crypto.randomBytes(8).toString('hex')),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

app.post('/api/transfer/room/:code/upload', upload.single('file'), (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Комната не найдена или срок истёк' });
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  const mid = String((req.body && req.body.mid) || '');
  const mem = room.members.get(mid);
  const rec = {
    id: req.file.filename,
    name: req.file.originalname || 'file',
    size: req.file.size,
    by: mem ? mem.name : 'Гость',
    ts: Date.now(),
    path: req.file.path,
  };
  room.files.set(rec.id, rec);
  touchRoom(room);
  res.json({ file: publicFile(rec) });
});

app.get('/api/transfer/room/:code/file/:fid', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Комната не найдена или срок истёк' });
  const rec = room.files.get(req.params.fid);
  if (!rec) return res.status(404).json({ error: 'Файл не найден' });
  touchRoom(room);
  res.download(rec.path, rec.name);
});

// ===== 404 / ошибки =====
app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Не найдено' });
  res.status(404).send(PAGE_404);
});

app.use((err, req, res, next) => {
  const status = err && err.status ? err.status : 400;
  const msg = err && err.code === 'LIMIT_FILE_SIZE'
    ? `Файл больше ${MAX_FILE_MB} МБ`
    : (err && err.message) || 'Ошибка';
  res.status(status).json({ error: msg });
});

app.listen(PORT, () => {
  console.log(`Toolbox listening on :${PORT}`);
});
