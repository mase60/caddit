// Anmeldung und erlaubte Hosts
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers.js');

let t;
test.before(async () => { t = await startApp({ UI_USER: 'mase', UI_PASS: 'a:b', ALLOWED_HOSTS: '127.0.0.1, caddit.lan' }); });
test.after(() => t.stop());

const basic = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(u + ':' + p).toString('base64') });

test('Ohne oder mit falscher Anmeldung: 401', async () => {
  assert.equal((await t.call('GET', '/api/state')).status, 401);
  assert.equal((await t.call('GET', '/api/state', undefined, basic('mase', 'falsch'))).status, 401);
});

test('Mit Anmeldung (Doppelpunkt im Passwort): Zugriff, „open“ ist aus', async () => {
  const r = await t.call('GET', '/api/state', undefined, basic('mase', 'a:b'));
  assert.equal(r.status, 200);
  assert.equal(r.json.open, false);
});

test('Host-Prüfung: fremder Host wird abgewiesen, auch mit Anmeldung', async () => {
  const http = require('http');
  const port = t.app.server.address().port;
  const status = (host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: host, ...basic('mase', 'a:b') } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(await status('boese.example'), 403);
  assert.equal(await status('caddit.lan:8080'), 200);
  assert.equal(await status('127.0.0.1:' + port), 200);
});
