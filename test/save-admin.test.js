// Speichern, wenn CADDY_ADMIN gesetzt ist: Das echte Caddy entscheidet, die Datei folgt erst danach.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startApp, fakeAdmin, FIRST } = require('./helpers.js');

let admin, t;
test.before(async () => {
  admin = await fakeAdmin();
  t = await startApp({ CADDY_ADMIN: admin.url });
});
test.after(async () => { await t.stop(); await new Promise((r) => admin.server.close(r)); });

const stateNow = async () => (await t.call('GET', '/api/state')).json;

test('Zustand meldet Fähigkeiten und Verlustfreiheit', async () => {
  const s = await stateNow();
  assert.equal(s.canValidate, false);
  assert.equal(s.canReload, true);
  assert.equal(s.lossless, true);
  assert.equal(s.open, true);
  assert.equal(s.entries[0].header, 'a.de');
});

test('Angenommen: geladen, geschrieben, Backup vorhanden', async () => {
  const s = await stateNow();
  const text = FIRST + '\nb.de {\n\trespond "ok"\n}\n';
  const r = await t.call('PUT', '/api/raw', { text, hash: s.hash });
  assert.equal(r.status, 200);
  assert.equal(r.json.reloaded, true);
  assert.equal(r.json.validated, true);
  assert.equal(t.read(), text);
  assert.equal(admin.received.at(-1).url, '/load');
  assert.equal(admin.received.at(-1).type, 'text/caddyfile');
  assert.equal(t.backupFiles().length, 1);
  assert.equal(fs.readFileSync(t.backups + '/' + t.backupFiles()[0], 'utf8'), FIRST);
});

test('Abgelehnt: Datei unverändert, kein neues Backup, klarer Fehler', async () => {
  const s = await stateNow();
  const before = t.read(), backups = t.backupFiles().length;
  const r = await t.call('PUT', '/api/raw', { text: 'KAPUTT {\n}\n', hash: s.hash });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /abgelehnt.*400/s);
  assert.equal(t.read(), before);
  assert.equal(t.backupFiles().length, backups);
});

test('Veralteter Stand: 409, ohne Caddy zu fragen', async () => {
  const n = admin.received.length;
  const r = await t.call('PUT', '/api/raw', { text: 'x {\n}\n', hash: 'alt' });
  assert.equal(r.status, 409);
  assert.equal(admin.received.length, n);
});

test('Zwei gleichzeitige Speichervorgänge: der zweite bekommt 409', async () => {
  const s = await stateNow();
  const [a, b] = await Promise.all([
    t.call('PUT', '/api/raw', { text: 'eins.de {\n}\n', hash: s.hash }),
    t.call('PUT', '/api/raw', { text: 'zwei.de {\n}\n', hash: s.hash }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(t.read(), a.status === 200 ? 'eins.de {\n}\n' : 'zwei.de {\n}\n');
});

test('Karten speichern: Rundlauf über /api/entries', async () => {
  fs.writeFileSync(t.file, FIRST);
  const s = await stateNow();
  s.entries[0].comment = 'Neu';
  const r = await t.call('PUT', '/api/entries', { entries: s.entries, hash: s.hash });
  assert.equal(r.status, 200);
  assert.equal(t.read(), '# Neu\n' + FIRST);
});

test('Karten speichern: unvollständige Klammern werden abgelehnt', async () => {
  const s = await stateNow();
  const before = t.read();
  s.entries[0].body = 'handle {';
  const r = await t.call('PUT', '/api/entries', { entries: s.entries, hash: s.hash });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Klammern/);
  assert.equal(t.read(), before);
});

test('Nicht verlustfrei darstellbare Datei: Karten gesperrt, Rohtext geht', async () => {
  fs.writeFileSync(t.file, 'a.de {\n\trespond "offen"\n');
  const s = await stateNow();
  assert.equal(s.lossless, false);
  const blocked = await t.call('PUT', '/api/entries', { entries: s.entries, hash: s.hash });
  assert.equal(blocked.status, 409);
  const raw = await t.call('PUT', '/api/raw', { text: FIRST, hash: s.hash });
  assert.equal(raw.status, 200);
});

test('Backups: Liste, Abruf, ungültige Namen', async () => {
  const list = (await t.call('GET', '/api/backups')).json.files;
  assert.ok(list.length > 0);
  assert.deepEqual(list, [...list].sort().reverse());
  const one = await t.call('GET', '/api/backups/' + list[0]);
  assert.equal(one.status, 200);
  assert.equal(typeof one.json.text, 'string');
  for (const bad of ['Caddyfile.2020-01-01T00-00-00-000Z', '..%2F..%2Fsecret', 'Caddyfile.%2E%2E']) {
    assert.equal((await t.call('GET', '/api/backups/' + bad)).status, 404, bad);
  }
});

test('Umlaute über viele Datenblöcke bleiben heil', async () => {
  const s = await stateNow();
  const text = 'a.de {\n\trespond "' + 'ä€'.repeat(60000) + '"\n}\n';
  const r = await t.call('PUT', '/api/raw', { text, hash: s.hash });
  assert.equal(r.status, 200);
  assert.equal(t.read(), text);
});

test('Statische Dateien und Schutz-Kopfzeilen', async () => {
  const page = await t.call('GET', '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const logic = await t.call('GET', '/logic.js');
  assert.equal(logic.status, 200);
  assert.match(logic.headers.get('content-type'), /javascript/);
  assert.equal((await t.call('GET', '/server.js')).status, 404);
});
