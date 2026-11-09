// caddit – kleiner Editor für die Caddyfile. Keine Abhängigkeiten, nur Node >= 20.
// Caddyfile-Text verstehen: public/logic.js. Hier: Speichern, Caddy ansprechen, Docker, HTTP.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { parse, serialize, isLossless, isBalanced, proxyTargets } = require('./public/logic.js');

const CADDYFILE = process.env.CADDYFILE || '/config/Caddyfile';
const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backups';
const CADDY_ADMIN = (process.env.CADDY_ADMIN || '').replace(/\/$/, ''); // z.B. http://192.168.1.10:2019
const CADDY_ADMIN_HOST = process.env.CADDY_ADMIN_HOST || ''; // optional: Host-Header für Admin-API
const CADDY_BIN = process.env.CADDY_BIN || 'caddy';
const PORT = parseInt(process.env.PORT || '8080', 10);
const UI_USER = process.env.UI_USER || '';
const UI_PASS = process.env.UI_PASS || '';
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').toLowerCase().split(/[,\s]+/).filter(Boolean); // leer = jeder Host
const KEEP_BACKUPS = 30;
const BACKUP_RE = /^Caddyfile\.[\dTZ-]+$/;
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/logic.js': ['logic.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// ---------- Caddy-Helfer ----------
const deps = { // austauschbar für Tests
  run: (cmd, args) => new Promise((resolve) =>
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) =>
      resolve({ err, out: (stdout || '') + (stderr || ''), missing: err && err.code === 'ENOENT' }))),
};

let caddyAvailable = null;
async function hasCaddy() {
  if (caddyAvailable === null) caddyAvailable = !(await deps.run(CADDY_BIN, ['version'])).missing;
  return caddyAvailable;
}

async function withTmpFile(text, fn) {
  let tmp = path.join(path.dirname(CADDYFILE), `.Caddyfile.ui-check-${process.pid}`);
  try { fs.writeFileSync(tmp, text); }
  catch { tmp = path.join(os.tmpdir(), `Caddyfile.ui-check-${process.pid}`); fs.writeFileSync(tmp, text); }
  try { return await fn(tmp); } finally { try { fs.unlinkSync(tmp); } catch {} }
}

async function format(text) {
  if (!(await hasCaddy())) return text;
  return withTmpFile(text, async (tmp) => {
    await deps.run(CADDY_BIN, ['fmt', '--overwrite', tmp]);
    return fs.readFileSync(tmp, 'utf8');
  });
}

// Prüfung mit dem caddy-Programm im caddit-Container. Nur der Ersatz, wenn das echte Caddy nicht erreichbar ist:
// Plugins, Zertifikate und Umgebungsvariablen des echten Caddy fehlen hier.
async function validateLocally(text) {
  if (!(await hasCaddy())) return { validated: false };
  return withTmpFile(text, async (tmp) => {
    const v = await deps.run(CADDY_BIN, ['validate', '--config', tmp, '--adapter', 'caddyfile']);
    if (v.err) return { error: v.out.replace(new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'Caddyfile').trim() };
    return { validated: true };
  });
}

// Ergebnis: { reloaded: true } | { reloaded: false, rejected: true, note } | { reloaded: false, note }
// Caddy übernimmt eine Konfiguration atomar: Lehnt es ab, läuft die bisherige unverändert weiter.
async function reload(text) {
  if (!CADDY_ADMIN) return { reloaded: false, note: 'CADDY_ADMIN nicht gesetzt – Datei gespeichert, Caddy nicht neu geladen.' };
  try {
    const u = new URL(CADDY_ADMIN + '/load');
    const host = CADDY_ADMIN_HOST || u.host;
    // Caddy prüft Host + Origin gegen "origins" – beide explizit setzen (fetch schickt einen leeren Origin)
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST', timeout: 15000,
        headers: { 'Content-Type': 'text/caddyfile', 'Content-Length': Buffer.byteLength(text), Host: host, Origin: 'http://' + host } }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      req.on('timeout', () => req.destroy(new Error('Timeout')));
      req.on('error', reject);
      req.end(text);
    });
    if (r.status >= 300) return { reloaded: false, rejected: true, note: `Caddy hat die Konfiguration abgelehnt (${r.status}), nichts wurde gespeichert:\n${r.body.trim()}` };
    return { reloaded: true };
  } catch (e) {
    return { reloaded: false, note: 'Datei gespeichert, Caddy aber nicht neu geladen: Admin-API nicht erreichbar (' + e.message + ').' };
  }
}

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');
const readFile = () => { try { return fs.readFileSync(CADDYFILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };

const listBackups = () => (fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_RE.test(f)).sort() : []);

// Gibt den Pfad des neuen Backups zurück (null, wenn es nichts zu sichern gab)
function backup(current) {
  if (!current) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `Caddyfile.${stamp}`);
  fs.writeFileSync(file, current);
  const files = listBackups();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  return file;
}

// Ablauf: Stand prüfen → formatieren → Backup → prüfen lassen → Datei schreiben.
// „Prüfen lassen“ heißt: das echte Caddy lädt die Konfiguration (POST /load). Erst wenn es sie angenommen hat, ändert sich die Datei.
// Ist Caddy nicht erreichbar, prüft das caddy-Programm im Container, und die Meldung sagt, dass nicht neu geladen wurde.
async function saveNow(text, baseHash) {
  const current = readFile();
  if (baseHash && baseHash !== hash(current)) throw httpErr(409, 'Die Caddyfile wurde zwischenzeitlich anderswo geändert.');
  const formatted = await format(text);
  let backupFile;
  try { backupFile = backup(current); }
  catch (e) { throw httpErr(500, 'Backup fehlgeschlagen, nichts wurde gespeichert: ' + e.message); }
  const dropBackup = () => { if (backupFile) { try { fs.unlinkSync(backupFile); } catch {} } }; // nichts geändert: kein Backup nötig

  const rl = await reload(formatted);
  if (rl.rejected) { dropBackup(); throw httpErr(400, rl.note); }
  let validated = rl.reloaded;
  if (!rl.reloaded) {
    const v = await validateLocally(formatted);
    if (v.error) { dropBackup(); throw httpErr(400, v.error); }
    validated = v.validated;
  }
  try {
    fs.writeFileSync(CADDYFILE, formatted); // in place, damit Bind-Mounts funktionieren
  } catch (e) {
    if (rl.reloaded && current) await reload(current); // Caddy und Datei nicht auseinanderlaufen lassen
    dropBackup();
    throw httpErr(500, 'Die Caddyfile konnte nicht geschrieben werden: ' + e.message);
  }
  return { ok: true, validated, ...rl, state: await state() };
}

// Immer nur ein Speichervorgang zugleich: Sonst bestehen zwei die Hash-Prüfung, und der letzte überschreibt den ersten.
let saveQueue = Promise.resolve();
function save(text, baseHash) {
  const result = saveQueue.then(() => saveNow(text, baseHash));
  saveQueue = result.catch(() => {});
  return result;
}

function checkEntries(entries) {
  for (const e of entries) {
    if (e === null || typeof e !== 'object') throw httpErr(400, 'Ungültiger Eintrag');
    if (e.kind !== 'comment' && e.kind !== 'raw' && !isBalanced(e.body)) {
      throw httpErr(400, `Der Inhalt von „${e.header || 'Globale Optionen'}“ hat unvollständige Klammern oder Anführungszeichen.`);
    }
  }
}

// ---------- Docker-Container → Icons ----------
const DOCKER_SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';
const HOST_IPS = (process.env.HOST_IP || '').split(/[,\s]+/).filter(Boolean);
let ctCache = { t: 0, list: [] };

function dockerContainers() {
  if (Date.now() - ctCache.t < 10000) return Promise.resolve(ctCache.list);
  if (!fs.existsSync(DOCKER_SOCK)) return Promise.resolve([]);
  return new Promise((resolve) => {
    const req = http.get({ socketPath: DOCKER_SOCK, path: '/containers/json', timeout: 3000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const list = JSON.parse(Buffer.concat(chunks).toString()).map((c) => ({
            name: (c.Names[0] || '').replace(/^\//, ''),
            icon: (c.Labels || {})['net.unraid.docker.icon'] || '',
            ips: Object.values((c.NetworkSettings || {}).Networks || {}).map((n) => n.IPAddress).filter(Boolean),
            ports: (c.Ports || []).map((p) => ({ priv: p.PrivatePort, pub: p.PublicPort })),
          }));
          ctCache = { t: Date.now(), list };
          resolve(list);
        } catch { resolve([]); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve([]));
  });
}

const isPrivateIp = (h) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
function matchContainer(t, list) {
  let c = list.find((x) => x.name.toLowerCase() === t.host);                              // Containername (gleiches Docker-Netz)
  if (!c) c = list.find((x) => x.ips.includes(t.host) && (!x.ports.length || x.ports.some((p) => p.priv === t.port))); // Container-IP
  if (!c) {                                                                               // veröffentlichter Port auf dem Unraid-Host
    const cand = list.filter((x) => x.ports.some((p) => p.pub === t.port));
    if (cand.length === 1 && (HOST_IPS.includes(t.host) || (!HOST_IPS.length && isPrivateIp(t.host)))) c = cand[0];
  }
  return c;
}
function entryMeta(e, list) {
  for (const t of e.kind === 'site' ? proxyTargets(e.body) : []) {
    const c = matchContainer(t, list);
    if (c) return { container: c.name, icon: c.icon };
  }
  return null;
}

async function state() {
  const raw = readFile();
  const entries = parse(raw);
  const [list, canValidate] = await Promise.all([dockerContainers(), hasCaddy()]);
  return { entries, meta: entries.map((e) => entryMeta(e, list)), raw, hash: hash(raw), file: CADDYFILE,
    lossless: isLossless(raw), canValidate, canReload: !!CADDY_ADMIN, open: !UI_USER };
}

// ---------- HTTP ----------
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const body = (req) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > 5e6) reject(httpErr(413, 'Zu groß')); else chunks.push(c); });
  req.on('end', () => { try { const d = Buffer.concat(chunks).toString(); resolve(d ? JSON.parse(d) : {}); } catch { reject(httpErr(400, 'Ungültiges JSON')); } });
  req.on('error', reject);
});
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

function authorized(req) {
  if (!UI_USER) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const [u, ...p] = Buffer.from(m[1], 'base64').toString().split(':');
  const a = Buffer.from(u + '\0' + p.join(':')), b = Buffer.from(UI_USER + '\0' + UI_PASS);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hostAllowed(req) {
  if (!ALLOWED_HOSTS.length) return true;
  const host = String(req.headers.host || '').toLowerCase();
  return ALLOWED_HOSTS.includes(host) || ALLOWED_HOSTS.includes(host.replace(/:\d+$/, ''));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (!hostAllowed(req)) return json(res, 403, { error: 'Host nicht erlaubt (ALLOWED_HOSTS)' });
    if (!authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="caddit"' }); return res.end('Login erforderlich'); }
    const url = new URL(req.url, 'http://x');
    const file = req.method === 'GET' && STATIC_FILES[url.pathname];
    if (file) {
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', file[0])));
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, await state());
    if (url.pathname === '/api/entries' && req.method === 'PUT') {
      const b = await body(req);
      if (!Array.isArray(b.entries)) throw httpErr(400, 'entries fehlt');
      checkEntries(b.entries);
      if (!isLossless(readFile())) throw httpErr(409, 'Die Kartenansicht kann diese Caddyfile nicht verlustfrei schreiben. Bitte im Rohtext bearbeiten.');
      return json(res, 200, await save(serialize(b.entries), b.hash));
    }
    if (url.pathname === '/api/raw' && req.method === 'PUT') {
      const b = await body(req);
      if (typeof b.text !== 'string') throw httpErr(400, 'text fehlt');
      return json(res, 200, await save(b.text.endsWith('\n') ? b.text : b.text + '\n', b.hash));
    }
    if (url.pathname === '/api/hash' && req.method === 'POST') {
      const b = await body(req);
      if (typeof b.password !== 'string' || !b.password || b.password.length > 256) throw httpErr(400, 'Passwort fehlt oder ist zu lang');
      if (!(await hasCaddy())) throw httpErr(501, 'caddy-Binary nicht verfügbar – Passwort-Hash kann nicht erzeugt werden.');
      const r = await deps.run(CADDY_BIN, ['hash-password', '--plaintext=' + b.password]);
      const h = r.out.trim();
      if (r.err || !/^\$2[aby]\$/.test(h)) throw httpErr(500, 'Hash konnte nicht erzeugt werden');
      return json(res, 200, { hash: h });
    }
    if (url.pathname === '/api/backups' && req.method === 'GET') return json(res, 200, { files: listBackups().reverse() });
    const backupName = /^\/api\/backups\/([^/]+)$/.exec(url.pathname);
    if (backupName && req.method === 'GET') {
      const name = decodeURIComponent(backupName[1]);
      if (!BACKUP_RE.test(name) || !listBackups().includes(name)) throw httpErr(404, 'Dieses Backup gibt es nicht.');
      return json(res, 200, { name, text: fs.readFileSync(path.join(BACKUP_DIR, name), 'utf8') });
    }
    json(res, 404, { error: 'Nicht gefunden' });
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`caddit auf :${PORT} – Datei: ${CADDYFILE}`);
    if (!UI_USER) console.warn(UI_PASS ? 'WARNUNG: UI_PASS ist gesetzt, UI_USER aber nicht – die Oberfläche ist ohne Anmeldung erreichbar.' : 'Hinweis: UI_USER/UI_PASS nicht gesetzt – die Oberfläche ist ohne Anmeldung erreichbar.');
  });
}
module.exports = { parse, serialize, proxyTargets, matchContainer, entryMeta, server, deps };
