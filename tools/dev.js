// Lokaler Dev-Server: die echte App mit Beispiel-Caddyfile (Kopie im Temp-Ordner) und Schein-Admin-API.
// Das Schein-Caddy nimmt alles an, außer die Konfiguration enthält „KAPUTT“. Ein caddy-Programm ist nicht nötig.
//   node tools/dev.js          http://127.0.0.1:3998
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const admin = http.createServer((req, res) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => {
    console.log(`Schein-Caddy: ${req.method} ${req.url} (${d.length} Zeichen)`);
    if (d.includes('KAPUTT')) { res.writeHead(400); return res.end('{"error":"adapting config using caddyfile: unrecognized directive: KAPUTT"}'); }
    res.writeHead(200); res.end();
  });
});

admin.listen(0, '127.0.0.1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddit-dev-'));
  const file = path.join(dir, 'Caddyfile');
  fs.writeFileSync(file, fs.readFileSync(path.join(__dirname, '..', 'test', 'Caddyfile'), 'utf8').replace(/\r\n/g, '\n'));
  Object.assign(process.env, { CADDYFILE: file, BACKUP_DIR: path.join(dir, 'backups'), CADDY_ADMIN: `http://127.0.0.1:${admin.address().port}` });
  const { server } = require('../server.js');
  const port = +(process.env.PORT || 3998);
  server.listen(port, '127.0.0.1', () => console.log(`caddit (Dev) auf http://127.0.0.1:${port} – Datei: ${file}`));
});
