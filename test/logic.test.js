const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const L = require('../public/logic.js');

const sample = fs.readFileSync(path.join(__dirname, 'Caddyfile'), 'utf8').replace(/\r\n/g, '\n');
const kinds = (entries) => entries.map((e) => [e.kind, e.header]);
const roundTrip = (t) => L.serialize(L.parse(t));

test('Beispieldatei: Rundlauf unverändert und verlustfrei', () => {
  assert.equal(roundTrip(sample), sample);
  assert.ok(L.isLossless(sample));
});

test('Kommentare an Klammern bleiben als Kommentar über dem Block erhalten', () => {
  const t = '# Oben\na.de { # Produktiv\n\treverse_proxy x:1\n} # Ende a\n';
  const e = L.parse(t);
  assert.equal(e[0].comment, '# Oben\n# Produktiv\n# Ende a');
  assert.ok(L.isLossless(t));
});

test('Kommentare in Inhalt und freistehend bleiben erhalten', () => {
  const t = '# frei\n\na.de {\n\t# innen\n\trespond "x" # hinten\n}\n';
  assert.ok(L.isLossless(t));
  assert.equal(L.parse(t)[0].kind, 'comment');
  assert.match(roundTrip(t), /# innen/);
});

test('Adressen über mehrere Zeilen sind ein Eintrag', () => {
  const t = 'a.de,\nb.de {\n\treverse_proxy x:1\n}\n\nc.de {\n\treverse_proxy y:2\n}\n';
  const e = L.parse(t);
  assert.deepEqual(kinds(e), [['site', 'a.de, b.de'], ['site', 'c.de']]);
  assert.ok(L.isLossless(t));
  assert.equal(L.serialize(e.slice(1)), 'c.de {\n\treverse_proxy y:2\n}\n'); // Löschen hinterlässt kein „a.de,“
});

test('Klammer in der Folgezeile gehört zur Adresse', () => {
  const t = 'a.de\n{\n\trespond "x"\n}\n';
  assert.deepEqual(kinds(L.parse(t)), [['site', 'a.de']]);
  assert.ok(L.isLossless(t));
});

test('Heredoc mit offener Klammer verschluckt keinen Nachbarn', () => {
  const t = 'h.de {\n\trespond <<HTML\n\t\t<style>\n\t\tbody {\n\n\t\t</style>\n\t\tHTML 200\n}\n\nn.de {\n\trespond "n"\n}\n';
  const e = L.parse(t);
  assert.deepEqual(kinds(e), [['site', 'h.de'], ['site', 'n.de']]);
  assert.equal(roundTrip(t), t);
});

test('Backtick über mehrere Zeilen bleibt Zeichen für Zeichen gleich', () => {
  const t = 'b.de {\n\trespond `a {\nb`\n}\n\nz.de {\n\trespond "z"\n}\n';
  assert.deepEqual(kinds(L.parse(t)), [['site', 'b.de'], ['site', 'z.de']]);
  assert.equal(roundTrip(t), t);
});

test('Klammern in Anführungszeichen und Platzhalter zählen nicht', () => {
  const t = 'a.de {\n\trespond "{"\n\tredir https://x.de{uri}\n\theader X {$Y}\n}\n\nb.de {\n\trespond "}"\n}\n';
  assert.deepEqual(kinds(L.parse(t)), [['site', 'a.de'], ['site', 'b.de']]);
  assert.ok(L.isLossless(t));
});

test('Doppelkreuz mitten im Token ist kein Kommentar', () => {
  const [l] = L.scanLines(['redir https://x.de/#anker']);
  assert.equal(l.comment, '');
  assert.equal(l.tokens[1], 'https://x.de/#anker');
});

test('Benannte Route gilt als Snippet, nicht als Site', () => {
  assert.equal(L.parse('&(api) {\n\treverse_proxy x:1\n}\n')[0].kind, 'snippet');
  assert.equal(L.parse('(s) {\n\tencode gzip\n}\n')[0].kind, 'snippet');
});

test('Rohzeilen bleiben, BOM und CRLF stören nicht', () => {
  const e = L.parse('﻿import a # x\r\nimport b\r\n');
  assert.deepEqual(kinds(e), [['raw', 'import a # x'], ['raw', 'import b']]);
});

test('Nicht darstellbare Dateien werden erkannt', () => {
  assert.equal(L.isLossless('a.de {\n\trespond "x"\n'), false); // Klammer fehlt
  assert.equal(L.isLossless('a.de {\n\trespond "x"\n}\n}\n'), true); // zusätzliche } bleibt als Rohzeile erhalten
});

test('Serialisieren: mehrzeiliger Kommentar, Leerzeilen', () => {
  const out = L.serialize([{ kind: 'site', header: 'a.de', comment: 'eins\n\n# zwei', body: 'x\n\n\ny\n\n' }]);
  assert.equal(out, '# eins\n# zwei\na.de {\n\tx\n\n\ty\n}\n');
});

test('isBalanced', () => {
  assert.ok(L.isBalanced('handle {\n\tx\n}'));
  assert.ok(L.isBalanced('respond "{"'));
  assert.equal(L.isBalanced('handle {'), false);
  assert.equal(L.isBalanced('}\n\nevil.de {'), false);
  assert.equal(L.isBalanced('respond `a'), false);
});

test('proxyTargets: Kurzform, Block, Matcher, verschachtelt', () => {
  assert.deepEqual(L.proxyTargets('reverse_proxy immich:2283'), [{ host: 'immich', port: 2283 }]);
  assert.deepEqual(L.proxyTargets('reverse_proxy {\n\tto immich:2283\n}'), [{ host: 'immich', port: 2283 }]);
  assert.deepEqual(L.proxyTargets('reverse_proxy @m https://a.de # k'), [{ host: 'a.de', port: 443 }]);
  assert.deepEqual(L.proxyTargets('handle {\n\treverse_proxy x:1 {\n\t\theader_up A b\n\t}\n}\nto y:2'), [{ host: 'x', port: 1 }]);
  assert.deepEqual(L.proxyTargets('respond <<H\n\treverse_proxy no:1\n\tH'), []);
});

test('directives: Klammerzeile mit Kommentar zählt mit', () => {
  assert.deepEqual(L.directives('handle { # x\n\treverse_proxy a:1\n}\nrespond "y"'), ['handle', 'respond "y"']);
});

test('splitAuth: einfache Form wird gelöst', () => {
  const r = L.splitAuth('basic_auth {\n\tu $2a$h\n}\nreverse_proxy a:1');
  assert.deepEqual(r, { rest: 'reverse_proxy a:1', auth: { user: 'u', hash: '$2a$h' }, complex: false });
});

test('splitAuth: verschachtelt bleibt, auch mit Kommentar an der Klammer', () => {
  const b = 'handle /a* { # nur Admin\n\tbasic_auth {\n\t\tu h\n\t}\n}\nreverse_proxy b:2';
  const r = L.splitAuth(b);
  assert.equal(r.auth, null);
  assert.equal(r.rest, b);
});

test('splitAuth: Kompliziertes bleibt vollständig im Inhalt', () => {
  for (const b of [
    'basic_auth /x {\n\tu h\n}',
    'basic_auth {\n\tu h\n\tv i\n}',
    'basic_auth { # k\n\tu h\n}',
    'basic_auth {\n\t# k\n\tu h\n}',
    'basic_auth {\n\tu h\n}\nbasic_auth /y {\n\tv i\n}',
  ]) {
    const r = L.splitAuth(b);
    assert.equal(r.complex, true, b);
    assert.equal(r.auth, null, b);
    assert.equal(r.rest, b, b);
  }
});

test('withAuth setzt den Block vor den Inhalt', () => {
  assert.equal(L.withAuth('u', 'h', 'x'), 'basic_auth {\n\tu h\n}\nx');
  assert.equal(L.withAuth('u', 'h', '  '), 'basic_auth {\n\tu h\n}');
});

test('Suche schaut in Inhalte, nicht in Feldnamen', () => {
  const e = { kind: 'site', header: 'a.de', comment: 'Cloud', body: 'reverse_proxy x:1' };
  for (const q of ['site', 'kind', 'body']) assert.equal(L.matchesSearch(e, q), false);
  for (const q of ['a.de', 'cloud', 'reverse', '']) assert.equal(L.matchesSearch(e, q), true);
});

test('Icon-Buchstabe', () => {
  const label = (header, kind = 'site') => L.iconLabel({ kind, header });
  assert.equal(label('www.foo.de'), 'f');
  assert.equal(label('https://bar.de'), 'b');
  assert.equal(label(':8080'), '8');
  assert.equal(label('*.foo.de'), 'f');
  assert.equal(label('', 'global'), '⚙');
  assert.equal(label('(x)', 'snippet'), '{}');
});

test('normalizeHeader ändert nur Adressen', () => {
  assert.equal(L.normalizeHeader('site', ' a.de ,b.de '), 'a.de, b.de');
  assert.equal(L.normalizeHeader('raw', 'import s "a,b"'), 'import s "a,b"');
});

test('Sortierung', () => {
  const items = ['www.b.de', 'a10.de', 'https://a2.de'].map((header, i) => ({ e: { header }, i }));
  assert.deepEqual(L.sortItems(items, 'az').map((x) => x.i), [2, 1, 0]);
  assert.deepEqual(L.sortItems(items, 'za').map((x) => x.i), [0, 1, 2]);
  assert.equal(L.sortItems(items, 'file'), items);
});

test('backupLabel', () => {
  assert.notEqual(L.backupLabel('Caddyfile.2026-11-09T10-06-00-123Z'), 'Caddyfile.2026-11-09T10-06-00-123Z');
  assert.equal(L.backupLabel('Caddyfile.kaputt'), 'Caddyfile.kaputt');
});

test('saveMessage', () => {
  assert.deepEqual(L.saveMessage({ reloaded: true, validated: true }, 'X'), { text: 'X – Caddy neu geladen ✓', type: 'ok' });
  assert.deepEqual(L.saveMessage({ reloaded: false, validated: true, note: 'N' }, 'X'), { text: 'X\nN', type: 'warn' });
  assert.match(L.saveMessage({ reloaded: false, validated: false }, 'X').text, /nicht geprüft/);
});

test('findEntry', () => {
  const es = [{ kind: 'site', header: 'a', body: 'x', comment: '' }, { kind: 'site', header: 'b', body: 'y', comment: '' }];
  assert.equal(L.findEntry(es, { kind: 'site', header: 'b', body: 'y' }), 1);
  assert.equal(L.findEntry(es, { kind: 'site', header: 'b', body: 'anders' }), -1);
});
