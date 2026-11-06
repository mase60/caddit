// Caddy UI – kleiner Editor für die Caddyfile. Keine Abhängigkeiten, nur Node >= 20.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CADDYFILE = process.env.CADDYFILE || '/config/Caddyfile';
const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backups';
const CADDY_ADMIN = (process.env.CADDY_ADMIN || '').replace(/\/$/, ''); // z.B. http://192.168.1.10:2019
const CADDY_ADMIN_HOST = process.env.CADDY_ADMIN_HOST || ''; // optional: Host-Header für Admin-API
const CADDY_BIN = process.env.CADDY_BIN || 'caddy';
const PORT = parseInt(process.env.PORT || '8080', 10);
const UI_USER = process.env.UI_USER || '';
const UI_PASS = process.env.UI_PASS || '';
const KEEP_BACKUPS = 30;

// ---------- Parser ----------
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === '`') { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s;
}
const opensBlock = (code) => code === '{' || /\s\{$/.test(code);

function parse(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const entries = [];
  let pending = [];
  let i = 0;
  const flushPending = () => {
    if (pending.length) entries.push({ kind: 'comment', comment: pending.join('\n') });
    pending = [];
  };
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '') { flushPending(); i++; continue; }
    if (t.startsWith('#')) { pending.push(t); i++; continue; }
    const code = stripComment(t);
    const comment = pending.join('\n');
    pending = [];
    if (opensBlock(code)) {
      const header = code === '{' ? '' : code.slice(0, -1).trim();
      let depth = 1;
      const body = [];
      i++;
      while (i < lines.length) {
        const c2 = stripComment(lines[i].trim());
        if (opensBlock(c2)) depth++;
        else if (c2 === '}') { depth--; if (depth === 0) { i++; break; } }
        body.push(lines[i]);
        i++;
      }
      const kind = header === '' ? 'global' : header.startsWith('(') ? 'snippet' : 'site';
      entries.push({ kind, header, comment, body: dedent(body) });
    } else {
      entries.push({ kind: 'raw', header: t, comment });
      i++;
    }
  }
  flushPending();
  return entries;
}

function dedent(lines) {
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  let min = Infinity;
  for (const l of lines) if (l.trim()) min = Math.min(min, l.match(/^\s*/)[0].length);
  if (!isFinite(min)) min = 0;
  return lines.map((l) => l.slice(min).replace(/\s+$/, '')).join('\n');
}

function serialize(entries) {
  return entries.map((e) => {
    const out = [];
    if (e.comment) out.push(...e.comment.split('\n').map((l) => (l.startsWith('#') ? l : '# ' + l)));
    if (e.kind === 'comment') return out.join('\n');
    if (e.kind === 'raw') { out.push(e.header); return out.join('\n'); }
    out.push(e.kind === 'global' ? '{' : `${e.header.trim()} {`);
    const body = (e.body || '').replace(/\r/g, '').split('\n');
    for (const l of body) if (l.trim()) out.push('\t' + l.replace(/\s+$/, '')); else if (out[out.length - 1] !== '') out.push('');
    while (out[out.length - 1] === '') out.pop();
    out.push('}');
    return out.join('\n');
  }).join('\n\n') + '\n';
}

// ---------- Caddy-Helfer ----------
const run = (cmd, args) => new Promise((resolve) =>
  execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) =>
    resolve({ err, out: (stdout || '') + (stderr || ''), missing: err && err.code === 'ENOENT' })));

let caddyAvailable = null;
async function hasCaddy() {
  if (caddyAvailable === null) caddyAvailable = !(await run(CADDY_BIN, ['version'])).missing;
  return caddyAvailable;
}

async function formatAndValidate(text) {
  if (!(await hasCaddy())) return { text, validated: false };
  const dir = path.dirname(CADDYFILE);
  let tmp = path.join(dir, `.Caddyfile.ui-check-${process.pid}`);
  try { fs.writeFileSync(tmp, text); }
  catch { tmp = path.join(os.tmpdir(), `Caddyfile.ui-check-${process.pid}`); fs.writeFileSync(tmp, text); }
  try {
    await run(CADDY_BIN, ['fmt', '--overwrite', tmp]);
    const formatted = fs.readFileSync(tmp, 'utf8');
    const v = await run(CADDY_BIN, ['validate', '--config', tmp, '--adapter', 'caddyfile']);
    if (v.err) return { error: v.out.replace(new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'Caddyfile').trim() };
    return { text: formatted, validated: true };
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

async function reload(text) {
  if (!CADDY_ADMIN) return { reloaded: false, note: 'CADDY_ADMIN nicht gesetzt – Datei gespeichert, Caddy nicht neu geladen.' };
  try {
    const u = new URL(CADDY_ADMIN + '/load');
    const host = CADDY_ADMIN_HOST || u.host;
    // Caddy prüft Host + Origin gegen "origins" – beide explizit setzen (fetch schickt einen leeren Origin)
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST', timeout: 15000,
        headers: { 'Content-Type': 'text/caddyfile', 'Content-Length': Buffer.byteLength(text), Host: host, Origin: 'http://' + host } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      req.on('timeout', () => req.destroy(new Error('Timeout')));
      req.on('error', reject);
      req.end(text);
    });
    if (r.status >= 300) return { reloaded: false, note: `Caddy hat das Reload abgelehnt (${r.status}): ${r.body.trim()}` };
    return { reloaded: true };
  } catch (e) {
    return { reloaded: false, note: 'Admin-API nicht erreichbar: ' + e.message };
  }
}

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');
const readFile = () => { try { return fs.readFileSync(CADDYFILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };

function backup(current) {
  if (!current) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(BACKUP_DIR, `Caddyfile.${stamp}`), current);
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('Caddyfile.')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

async function save(text, baseHash) {
  const current = readFile();
  if (baseHash && baseHash !== hash(current)) throw httpErr(409, 'Die Caddyfile wurde zwischenzeitlich geändert. Bitte Seite neu laden.');
  const res = await formatAndValidate(text);
  if (res.error) throw httpErr(400, res.error);
  try { backup(current); } catch (e) { console.error('Backup fehlgeschlagen:', e.message); }
  fs.writeFileSync(CADDYFILE, res.text); // in place, damit Bind-Mounts funktionieren
  const rl = await reload(res.text);
  return { ok: true, validated: res.validated, ...rl, state: state() };
}

function state() {
  const raw = readFile();
  return { entries: parse(raw), raw, hash: hash(raw), file: CADDYFILE, canValidate: caddyAvailable, canReload: !!CADDY_ADMIN };
}

// ---------- HTTP ----------
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const body = (req) => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 5e6) reject(httpErr(413, 'Zu groß')); });
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(httpErr(400, 'Ungültiges JSON')); } });
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

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Caddy UI"' }); return res.end('Login erforderlich'); }
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (url.pathname === '/api/state' && req.method === 'GET') { await hasCaddy(); return json(res, 200, state()); }
    if (url.pathname === '/api/entries' && req.method === 'PUT') {
      const b = await body(req);
      if (!Array.isArray(b.entries)) throw httpErr(400, 'entries fehlt');
      return json(res, 200, await save(serialize(b.entries), b.hash));
    }
    if (url.pathname === '/api/raw' && req.method === 'PUT') {
      const b = await body(req);
      if (typeof b.text !== 'string') throw httpErr(400, 'text fehlt');
      return json(res, 200, await save(b.text.endsWith('\n') ? b.text : b.text + '\n', b.hash));
    }
    if (url.pathname === '/api/backups' && req.method === 'GET') {
      const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('Caddyfile.')).sort().reverse() : [];
      return json(res, 200, { files });
    }
    json(res, 404, { error: 'Nicht gefunden' });
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Caddy UI auf :${PORT} – Datei: ${CADDYFILE}`));
}
module.exports = { parse, serialize };
