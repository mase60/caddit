// Speichern ohne erreichbare Admin-API: Das caddy-Programm im Container prüft ersatzweise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startApp, FIRST } = require('./helpers.js');

let t;
const calls = [];
test.before(async () => {
  t = await startApp({ CADDY_ADMIN: 'http://127.0.0.1:1' }); // niemand hört dort
  t.app.deps.run = async (_cmd, args) => {
    calls.push(args[0]);
    if (args[0] === 'version') return { err: null, out: 'v2', missing: false };
    if (args[0] === 'fmt') { fs.appendFileSync(args[2], '# formatiert\n'); return { err: null, out: '', missing: false }; }
    if (args[0] === 'validate') {
      const text = fs.readFileSync(args[2], 'utf8');
      return text.includes('KAPUTT') ? { err: new Error('x'), out: `Fehler in ${args[2]}:3`, missing: false } : { err: null, out: '', missing: false };
    }
    if (args[0] === 'hash-password') return { err: null, out: '$2a$14$abc\n', missing: false };
    throw new Error('unerwartet: ' + args[0]);
  };
});
test.after(() => t.stop());

const stateNow = async () => (await t.call('GET', '/api/state')).json;

test('Caddy nicht erreichbar: lokal geprüft, gespeichert, Hinweis', async () => {
  const s = await stateNow();
  assert.equal(s.canValidate, true);
  const r = await t.call('PUT', '/api/raw', { text: FIRST, hash: s.hash });
  assert.equal(r.status, 200);
  assert.equal(r.json.reloaded, false);
  assert.equal(r.json.validated, true);
  assert.match(r.json.note, /nicht erreichbar/);
  assert.equal(t.read(), FIRST + '# formatiert\n');
  assert.ok(calls.includes('validate'));
});

test('Lokale Prüfung lehnt ab: Datei unverändert, Pfad nicht in der Meldung', async () => {
  const s = await stateNow();
  const before = t.read(), backups = t.backupFiles().length;
  const r = await t.call('PUT', '/api/raw', { text: 'KAPUTT {\n}\n', hash: s.hash });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Fehler in Caddyfile:3/);
  assert.equal(t.read(), before);
  assert.equal(t.backupFiles().length, backups);
});

test('Backup scheitert: nichts wird gespeichert', async () => {
  const s = await stateNow();
  const before = t.read();
  fs.rmSync(t.backups, { recursive: true, force: true });
  fs.writeFileSync(t.backups, 'hier liegt eine Datei statt eines Ordners');
  const r = await t.call('PUT', '/api/raw', { text: 'neu.de {\n}\n', hash: s.hash });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /Backup fehlgeschlagen/);
  assert.equal(t.read(), before);
  fs.rmSync(t.backups);
});

test('Passwort-Hash', async () => {
  assert.equal((await t.call('POST', '/api/hash', { password: 'geheim' })).json.hash, '$2a$14$abc');
  assert.equal((await t.call('POST', '/api/hash', { password: '' })).status, 400);
});
