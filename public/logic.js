// Reine Logik ohne DOM und ohne Dateizugriff: läuft im Browser (window.Logic) und in Node (require).
// Alles, was Caddyfile-Text zeilenweise versteht, geht über scanLines. Bitte keine eigene Klammerzählung daneben.
(function (root) {
  'use strict';

  // ---------- Lexer ----------
  // Liest Zeilen wie der Caddyfile-Lexer. Je Zeile:
  //   inside   'quote' | 'heredoc' | null: die Zeile beginnt in einem mehrzeiligen Text bzw. Heredoc
  //   code     Zeile ohne Kommentar, getrimmt
  //   comment  Kommentar der Zeile samt '#', sonst ''
  //   tokens   Tokens der Zeile (Anführungszeichen entfernt)
  //   delta    Veränderung der Klammertiefe (nur echte Tokens '{' und '}')
  //   literal  Inhaltszeile eines Heredocs (sonst nicht gesetzt)
  function scanLines(lines) {
    let quote = null, heredoc = null;
    return lines.map((raw) => {
      const inside = quote ? 'quote' : heredoc ? 'heredoc' : null;
      if (heredoc) {
        const t = raw.trim();
        if (t !== heredoc && !t.startsWith(heredoc + ' ') && !t.startsWith(heredoc + '\t')) {
          return { inside, code: '', comment: '', tokens: [], delta: 0, literal: raw };
        }
        heredoc = null;
      }
      const tokens = [];
      let val = '', started = false, wasQuoted = quote !== null, delta = 0, commentAt = -1, lastPlain = false;
      const end = () => {
        if (!started) return;
        tokens.push(val);
        lastPlain = !wasQuoted;
        if (!wasQuoted && val === '{') delta++;
        if (!wasQuoted && val === '}') delta--;
        val = ''; started = false; wasQuoted = false;
      };
      if (quote) started = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (quote) {
          if (quote === '"' && c === '\\') { val += raw[i + 1] ?? ''; i++; continue; }
          if (c === quote) { quote = null; end(); continue; }
          val += c;
          continue;
        }
        if (c === ' ' || c === '\t' || c === '\r') { end(); continue; }
        if (c === '#' && !started) { commentAt = i; break; }
        if (c === '\\') { val += c + (raw[i + 1] ?? ''); started = true; i++; continue; }
        if (!started && (c === '"' || c === '`')) { quote = c; started = true; wasQuoted = true; continue; }
        val += c;
        started = true;
      }
      end(); // ein offener Text geht in der nächsten Zeile weiter (quote bleibt gesetzt)
      const last = tokens[tokens.length - 1];
      if (!quote && commentAt < 0 && lastPlain && last && /^<<[A-Za-z0-9_-]+$/.test(last)) heredoc = last.slice(2);
      return {
        inside,
        code: (commentAt >= 0 ? raw.slice(0, commentAt) : raw).trim(),
        comment: commentAt >= 0 ? raw.slice(commentAt).trim() : '',
        tokens,
        delta,
      };
    });
  }

  const toLines = (text) => String(text ?? '').replace(/\r/g, '').split('\n');

  function isBalanced(body) {
    const scan = scanLines(toLines(body).concat(''));
    let depth = 0;
    for (const l of scan) { depth += l.delta; if (depth < 0) return false; }
    return depth === 0 && !scan[scan.length - 1].inside;
  }

  // ---------- Parser und Serializer ----------
  function dedent(lines) {
    const scan = scanLines(lines);
    let a = 0, b = lines.length;
    while (a < b && !scan[a].inside && !lines[a].trim()) a++;
    while (b > a && !scan[b - 1].inside && !lines[b - 1].trim()) b--;
    let min = Infinity;
    for (let i = a; i < b; i++) if (scan[i].inside !== 'quote' && lines[i].trim()) min = Math.min(min, lines[i].match(/^\s*/)[0].length);
    if (!isFinite(min)) min = 0;
    const out = [];
    for (let i = a; i < b; i++) {
      if (scan[i].inside === 'quote') out.push(lines[i]);
      else if (scan[i].inside === 'heredoc') out.push(lines[i].slice(min));
      else out.push(lines[i].slice(min).trimEnd());
    }
    return out.join('\n');
  }

  function parse(text) {
    const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
    const scan = scanLines(lines);
    const n = lines.length;
    const entries = [];
    let pending = [];
    let i = 0;
    const flushPending = () => {
      if (pending.length) entries.push({ kind: 'comment', comment: pending.join('\n') });
      pending = [];
    };
    const blank = (k) => !scan[k].inside && lines[k].trim() === '';
    while (i < n) {
      const l = scan[i];
      if (blank(i)) { flushPending(); i++; continue; }
      if (!l.inside && !l.code && l.comment) { pending.push(l.comment); i++; continue; }

      // Kopf eines Blocks suchen: gleiche Zeile, Adressen über mehrere Zeilen („a.de,“) oder „{“ in der Folgezeile
      const extra = l.comment ? [l.comment] : [];
      const parts = [l.code];
      let open = l.delta > 0 ? i : -1;
      if (open < 0 && !l.inside && l.delta === 0) {
        if (l.code.endsWith(',')) {
          const seenParts = [], seenExtra = [];
          for (let j = i + 1; j < n; j++) {
            const s = scan[j];
            if (s.inside) break;
            if (blank(j)) continue;
            if (!s.code) { seenExtra.push(s.comment); continue; }
            seenParts.push(s.code);
            if (s.comment) seenExtra.push(s.comment);
            if (s.delta > 0) { open = j; break; }
            if (s.delta !== 0 || !s.code.endsWith(',')) break;
          }
          if (open >= 0) { parts.push(...seenParts); extra.push(...seenExtra); }
        } else if (i + 1 < n && !scan[i + 1].inside && scan[i + 1].code === '{') {
          open = i + 1;
          parts.push('{');
          if (scan[i + 1].comment) extra.push(scan[i + 1].comment);
        }
      }

      if (open >= 0) {
        const header = parts.join(' ').replace(/\s*\{$/, '').trim();
        if (open === i && l.comment && extra[0] !== l.comment) extra.unshift(l.comment);
        let depth = scan[open].delta;
        const body = [];
        let k = open + 1;
        for (; k < n; k++) {
          const s = scan[k];
          depth += s.delta;
          if (depth <= 0) {
            if (s.code !== '}') body.push(lines[k]);
            if (s.comment) extra.push(s.comment);
            k++;
            break;
          }
          body.push(lines[k]);
        }
        const kind = header === '' ? 'global' : /^&?\(/.test(header) ? 'snippet' : 'site';
        entries.push({ kind, header, comment: pending.concat(extra).join('\n'), body: dedent(body) });
        pending = [];
        i = k;
        continue;
      }

      // Einzelne Zeile, die auch über mehrere Zeilen gehen kann (mehrzeiliger Text, Heredoc)
      let k = i;
      while (k + 1 < n && scan[k + 1].inside) k++;
      entries.push({ kind: 'raw', header: lines.slice(i, k + 1).join('\n').trim(), comment: pending.join('\n') });
      pending = [];
      i = k + 1;
    }
    flushPending();
    return entries;
  }

  function serialize(entries) {
    return entries.map((e) => {
      const out = [];
      if (e.comment) out.push(...toLines(e.comment).filter((l) => l.trim()).map((l) => (l.startsWith('#') ? l : '# ' + l)));
      if (e.kind === 'comment') return out.join('\n');
      if (e.kind === 'raw') { out.push(e.header); return out.join('\n'); }
      out.push(e.kind === 'global' ? '{' : `${e.header.trim()} {`);
      const body = toLines(e.body);
      const scan = scanLines(body);
      body.forEach((l, k) => {
        if (scan[k].inside === 'quote') out.push(l);                 // mehrzeiliger Text bleibt Zeichen für Zeichen gleich
        else if (scan[k].inside === 'heredoc') out.push(l.trim() ? '\t' + l : '');
        else if (l.trim()) out.push('\t' + l.trimEnd());
        else if (out[out.length - 1] !== '') out.push('');
      });
      while (out[out.length - 1] === '') out.pop();
      out.push('}');
      return out.join('\n');
    }).join('\n\n') + '\n';
  }

  // Inhalt ohne Formatierung: Tokens, Heredoc-Zeilen und alle Kommentare.
  function signature(text) {
    const scan = scanLines(String(text ?? '').replace(/^﻿/, '').split(/\r?\n/));
    const tokens = [], comments = [];
    for (const l of scan) {
      if (l.literal !== undefined) { if (l.literal.trim()) tokens.push(l.literal.trim()); }
      else tokens.push(...l.tokens);
      if (l.comment) comments.push(l.comment);
    }
    return JSON.stringify([tokens, comments.sort()]);
  }

  // Kann die Kartenansicht diese Datei verlustfrei wieder schreiben?
  const isLossless = (text) => signature(text) === signature(serialize(parse(text)));

  // ---------- Inhalt eines Blocks verstehen ----------
  function proxyTargets(body) {
    const out = [];
    const add = (args) => {
      for (const tok of args) {
        if (!tok || /^[@/{*]/.test(tok)) continue;
        const m = /^(?:(\w+):\/\/)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?/.exec(tok);
        if (m) out.push({ host: m[2].toLowerCase(), port: m[3] ? +m[3] : m[1] === 'https' ? 443 : 80 });
      }
    };
    let depth = 0, proxyDepth = null;
    for (const l of scanLines(toLines(body))) {
      const [name, ...args] = l.inside === 'quote' ? [] : l.tokens;
      if (name === 'reverse_proxy') {
        add(args);
        if (l.delta > 0) proxyDepth = depth + 1;
      } else if (name === 'to' && depth === proxyDepth) {
        add(args);
      }
      depth += l.delta;
      if (proxyDepth !== null && depth < proxyDepth) proxyDepth = null;
    }
    return out;
  }

  // Direktiven der obersten Ebene eines Blocks
  function directives(body) {
    const out = [];
    let depth = 0;
    for (const l of scanLines(toLines(body))) {
      if (depth === 0 && !l.inside && l.code) out.push(l.code.replace(/\s*\{$/, ''));
      depth = Math.max(0, depth + l.delta);
    }
    return out;
  }

  // basic_auth { user hash } aus dem Inhalt lösen. Alles Kompliziertere (Matcher, Algorithmus, mehrere Benutzer,
  // Kommentare darin) bleibt unangetastet im Inhalt und meldet sich als `complex`.
  function splitAuth(body) {
    const lines = toLines(body);
    const scan = scanLines(lines);
    const isAuth = (l) => !l.inside && (l.tokens[0] === 'basic_auth' || l.tokens[0] === 'basicauth');
    const simpleBlock = (i) => {
      if (scan[i].tokens.length !== 2 || scan[i].tokens[1] !== '{' || scan[i].comment) return null;
      const users = [];
      for (let j = i + 1; j < lines.length; j++) {
        const s = scan[j];
        if (s.inside || s.comment) return null;
        if (s.code === '}') return users.length === 1 && users[0].length === 2 ? { user: users[0][0], hash: users[0][1], end: j } : null;
        if (s.delta !== 0) return null;
        if (s.code) users.push(s.tokens);
      }
      return null;
    };
    const rest = [];
    let auth = null, depth = 0, count = 0, complex = false;
    for (let i = 0; i < lines.length; i++) {
      const l = scan[i];
      if (depth === 0 && isAuth(l)) {
        count++;
        const block = simpleBlock(i);
        if (block && !auth) { auth = { user: block.user, hash: block.hash }; i = block.end; continue; }
        complex = true;
      }
      depth = Math.max(0, depth + l.delta);
      rest.push(lines[i]);
    }
    if (complex || count > 1) return { rest: String(body ?? ''), auth: null, complex: true };
    return { rest: rest.join('\n').replace(/^\s*\n+|\n+\s*$/g, ''), auth, complex: false };
  }

  const withAuth = (user, hash, body) => `basic_auth {\n\t${user} ${hash}\n}` + (String(body).trim() ? '\n' + body : '');

  // ---------- Anzeige ----------
  const sortKey = (e) => (e.header || '').split(/[\s,]+/)[0].replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/^www\./, '').toLowerCase();

  function sortItems(list, mode) {
    if (mode === 'file') return list;
    const dir = mode === 'za' ? -1 : 1;
    return list.slice().sort((a, b) => dir * sortKey(a.e).localeCompare(sortKey(b.e), 'de', { numeric: true, sensitivity: 'base' }));
  }

  const matchesSearch = (e, q) => !q || [e.header, e.body, e.comment].some((s) => (s || '').toLowerCase().includes(q));

  function iconLabel(e) {
    if (e.kind === 'global') return '⚙';
    if (e.kind === 'snippet') return '{}';
    return (e.header || '?').replace(/^(https?:\/\/)?\W*(www\.)?/i, '')[0] || '?';
  }

  // Mehrere Adressen einheitlich schreiben; Rohzeilen und andere Arten bleiben wörtlich
  const normalizeHeader = (kind, value) => (kind === 'site' ? value.trim().replace(/\s*,\s*/g, ', ') : value.trim());

  function backupLabel(name) {
    const m = /^Caddyfile\.(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/.exec(name);
    if (!m) return name;
    const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
    return isNaN(d) ? name : d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'medium' });
  }

  // Dasselbe Ergebnis, dieselbe Meldung: Karten und Rohtext nutzen beide diese Funktion.
  function saveMessage(r, okMsg) {
    if (r.reloaded) return { text: okMsg + ' – Caddy neu geladen ✓', type: 'ok' };
    const lines = [okMsg];
    if (r.note) lines.push(r.note);
    if (!r.validated) lines.push('Die Datei wurde nicht geprüft: Kein caddy-Programm und keine erreichbare Admin-API.');
    return { text: lines.join('\n'), type: 'warn' };
  }

  // Nach einem Neuladen denselben Eintrag wiederfinden. -1, wenn er sich geändert hat oder weg ist.
  const findEntry = (entries, base) => entries.findIndex((e) =>
    e.kind === base.kind && (e.header || '') === (base.header || '') && (e.body || '') === (base.body || '') && (e.comment || '') === (base.comment || ''));

  const api = {
    scanLines, isBalanced, parse, serialize, signature, isLossless, proxyTargets, directives, splitAuth, withAuth,
    sortKey, sortItems, matchesSearch, iconLabel, normalizeHeader, backupLabel, saveMessage, findEntry,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
