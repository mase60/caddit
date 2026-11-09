// Startet den echten Server in diesem Prozess: mit eigener Caddyfile, Schein-Admin-API und Schein-caddy-Programm.
// Die Umgebung wird beim Laden von server.js gelesen, deshalb je Testdatei genau einmal aufrufen.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const FIRST = 'a.de {\n\treverse_proxy x:1\n}\n';

// Schein-Caddy: nimmt alles an, außer die Konfiguration enthält „KAPUTT“
function fakeAdmin() {
  const admin = { received: [], mode: 'normal' };
  admin.server = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      admin.received.push({ url: req.url, type: req.headers['content-type'], text: d });
      if (d.includes('KAPUTT')) { res.writeHead(400); return res.end('{"error":"adapting config: KAPUTT"}'); }
      res.writeHead(200); res.end();
    });
  });
  return new Promise((resolve) => admin.server.listen(0, '127.0.0.1', () => { admin.url = `http://127.0.0.1:${admin.server.address().port}`; resolve(admin); }));
}

async function startApp(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddit-test-'));
  const file = path.join(dir, 'Caddyfile');
  const backups = path.join(dir, 'backups');
  fs.writeFileSync(file, FIRST);
  Object.assign(process.env, { CADDYFILE: file, BACKUP_DIR: backups, CADDY_BIN: path.join(dir, 'gibt-es-nicht'), DOCKER_SOCK: path.join(dir, 'kein-socket') }, env);
  const app = require('../server.js');
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, data, headers = {}) => {
    const r = await fetch(base + url, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  const read = () => fs.readFileSync(file, 'utf8');
  const backupFiles = () => (fs.existsSync(backups) ? fs.readdirSync(backups) : []);
  const stop = () => new Promise((resolve) => app.server.close(resolve));
  return { app, call, read, file, dir, backups, backupFiles, stop };
}

module.exports = { startApp, fakeAdmin, FIRST };
