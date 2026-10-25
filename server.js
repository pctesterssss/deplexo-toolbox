'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const multer = require('multer');

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.TOOLBOX_TOKEN || null; // опциональный пароль на управление ссылками
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;   // комната живёт максимум 6 часов
const ROOM_IDLE_MS = 30 * 60 * 1000;      // ...или 30 минут без участников и активности
const MEMBER_ONLINE_MS = 40 * 1000;

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

let links = [];
try { links = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); } catch (e) { links = []; }

let saveTimer = null;
function saveLinks() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(LINKS_FILE, JSON.stringify(links)); } catch (e) { /* ignore */ }
  }, 300);
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // без i, l, o, 0, 1
function randCode(n) {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

function sanitizeName(raw) {
  let s = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
  return s || 'Гость';
}

function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  return `${req.protocol}://${req.get('host')}`;
}

function publicFile(rec) {
  return { id: rec.id, name: rec.name, size: rec.size, by: rec.by, ts: rec.ts };
}

// ---------- комнаты передачи ----------
const rooms = new Map(); // code -> room

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
    members: new Map(),   // id -> {id, name, lastSeen}
    messages: [],
    files: new Map(),     // fid -> {id, name, size, by, ts, path}
    inboxes: new Map(),   // mid -> [{from, type, payload}]
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
    const online = Array.from(room.members.values()).some(m => now - m.lastSeen < MEMBER_ONLINE_MS);
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

function auth(req, res, next) {
  if (!TOKEN) return next();
  const k = req.query.key || req.get('x-toolbox-key');
  if (k !== TOKEN) return res.status(401).json({ error: 'нужен TOOLBOX_TOKEN' });
  next();
}

// ---------- короткие ссылки ----------
app.post('/api/shorten', (req, res) => {
  let u;
  try { u = new URL(String((req.body && req.body.url) || '')); } catch (e) {
    return res.status(400).json({ error: 'Некорректный URL' });
  }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'Только http(s) URL' });
  let id;
  do { id = randCode(6); } while (links.some(l => l.id === id));
  const link = { id, url: u.toString(), created: Date.now(), clicks: 0 };
  links.unshift(link);
  saveLinks();
  res.json({ id, short: `${baseUrl(req)}/s/${id}` });
});

app.get('/api/links', auth, (req, res) => res.json({ links }));

app.delete('/api/links/:id', auth, (req, res) => {
  const i = links.findIndex(l => l.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Нет такой ссылки' });
  links.splice(i, 1);
  saveLinks();
  res.json({ ok: true });
});

const PAGE_404 = '<!doctype html><meta charset="utf-8"><title>404</title>' +
  '<body style="font-family:system-ui;background:#0e1013;color:#e6e9ef;display:flex;min-height:90vh;align-items:center;justify-content:center;flex-direction:column;gap:12px">' +
  '<div style="font-size:22px">Ссылка не найдена.</div>' +
  '<a style="color:#4f8cff" href="/">На главную</a></body>';

app.get('/s/:id', (req, res) => {
  const link = links.find(l => l.id === req.params.id);
  if (!link) return res.status(404).send(PAGE_404);
  link.clicks++;
  saveLinks();
  res.redirect(302, link.url);
});

// ---------- QR ----------
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

// ---------- комнаты ----------
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
  const members = Array.from(room.members.values()).map(m => ({
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

// ---------- прочее ----------
app.get('/healthz', (req, res) => res.json({ ok: true, links: links.length, rooms: rooms.size }));

app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Не найдено' });
  res.status(404).send(PAGE_404);
});

app.use((err, req, res, next) => {
  const status = err && err.status ? err.status : 400;
  const msg = err && err.code === 'LIMIT_FILE_SIZE' ? `Файл больше ${MAX_FILE_MB} МБ` : (err && err.message) || 'Ошибка';
  res.status(status).json({ error: msg });
});

app.listen(PORT, () => {
  console.log(`Toolbox listening on :${PORT}`);
});
