// Oberfläche: Zustand, Darstellung, Dialoge. Reine Logik steht in logic.js (window.Logic) und ist dort getestet.
const L = window.Logic;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// ----- Zustand -----
let S = { entries: [], meta: [], hash: '' };    // Stand des Servers (nur setState ändert ihn)
let rawDirty = false;                           // Rohtext-Feld weicht vom Serverstand ab
let rawBase = '';                               // Hash des Stands, auf dem der Rohtext-Entwurf beruht
let sortMode = ['az', 'za', 'file'].includes(localStorage.getItem('caddit-sort')) ? localStorage.getItem('caddit-sort') : 'az';
let view = localStorage.getItem('caddit-view') === 'list' ? 'list' : '';
// Eintrags-Dialog
let editing = null;       // Index in S.entries oder -1 für neu
let editBase = null;      // der Eintrag beim Öffnen, um ihn nach einem Neuladen wiederzufinden
let bodyTouched = false;  // Inhalt von Hand geändert: Vorlage und Zielfeld überschreiben ihn nicht mehr
let formClean = '';       // Stand der Felder beim Öffnen
let authHash = '';

function toast(msg, type = 'ok', ms = 4500) {
  const t = $('toast'); t.textContent = msg; t.className = type; t.style.display = 'block';
  clearTimeout(toast.t); if (ms) toast.t = setTimeout(() => (t.style.display = 'none'), ms);
}
$('toast').onclick = () => { $('toast').style.display = 'none'; };

async function api(method, url, data) {
  let r;
  try { r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined }); }
  catch { throw new Error('Server nicht erreichbar.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status });
  return j;
}

function setState(st) {
  S = st;
  $('file').textContent = st.file;
  $('openHint').hidden = !st.open;
  $('add').disabled = st.lossless === false;
  if (!rawDirty) { $('raw').value = st.raw; rawBase = st.hash; }
  syncRaw();
  render();
}
async function load() { try { setState(await api('GET', '/api/state')); } catch (e) { toast(e.message, 'err', 0); } }

function showResult(r, okMsg) {
  const m = L.saveMessage(r, okMsg);
  toast(m.text, m.type, m.type === 'ok' ? 4500 : 9000);
}

// ----- Darstellung -----
function chips(e) {
  const out = [];
  for (const d of L.directives(e.body)) {
    const [name, ...args] = d.split(/\s+/);
    if (name === 'reverse_proxy') out.push(`<span class="chip proxy">→ ${esc(args.filter(a=>!a.startsWith('@')&&a!=='/*').join(' ') || '(Block)')}</span>`);
    else if (name === 'file_server') out.push(`<span class="chip proxy">Dateien</span>`);
    else if (name === 'root') out.push(`<span class="chip">root ${esc(args.slice(-1)[0])}</span>`);
    else if (name === 'redir') out.push(`<span class="chip warn">redir ${esc(args.join(' '))}</span>`);
    else if (name === 'respond') out.push(`<span class="chip">respond ${esc(args.join(' '))}</span>`);
    else if (name === 'basic_auth' || name === 'basicauth') out.push(`<span class="chip ok">🔒 Login</span>`);
    else if (name === 'tls') out.push(`<span class="chip ok">tls ${esc(args.join(' '))}</span>`);
    else if (name === 'import') out.push(`<span class="chip">import ${esc(args.join(' '))}</span>`);
    else if (name.startsWith('@')) continue;
    else out.push(`<span class="chip">${esc(name)}</span>`);
  }
  return out.length ? out.join('') : '<span class="chip">leer</span>';
}
function siteLinks(h) {
  return h.split(/[\s,]+/).filter(Boolean).map((a) => {
    const clean = a.replace(/^https?:\/\//, '');
    const link = /^[\w.*-]+(:\d+)?(\/.*)?$/.test(clean) && !clean.startsWith('*') ? (a.startsWith('http://') ? a : (/:80$/.test(clean) ? 'http://' : 'https://') + clean) : null;
    return link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(a)}</a>` : esc(a);
  });
}
const PH = ['#4f8cff','#3ecf8e','#f5a524','#b36bff','#ff6b8b','#2fc4d6','#8b93a5'];
function icon(e, i) {
  const m = (S.meta || [])[i];
  const label = L.iconLabel(e);
  const ph = `<span class="ico ph" style="background:${PH[(label.charCodeAt(0) || 0) % PH.length]}">${esc(label)}</span>`;
  if (!m || !m.icon) return m ? `<span title="Container: ${esc(m.container)}">${ph}</span>` : ph;
  return `<img class="ico" src="${esc(m.icon)}" referrerpolicy="no-referrer" loading="lazy" title="Container: ${esc(m.container)}" alt="" data-ph="${esc(ph)}">`;
}
function card(e, i) {
  let title, more = '';
  if (e.kind === 'site') { const l = siteLinks(e.header); title = l[0] || esc(e.header); if (l.length > 1) more = `<span class="more">+ ${l.slice(1).join(', ')}</span>`; }
  else if (e.kind === 'global') title = 'Globale Optionen';
  else title = esc(e.header);
  const actions = S.lossless === false ? '' : `<div class="actions"><button class="sm" data-act="edit">Bearbeiten</button><button class="sm danger" data-act="del">Löschen</button></div>`;
  return `<div class="card" data-i="${i}">
    <div class="top"><div class="titlebox">${icon(e, i)}<div class="addr">${title}${more}</div></div></div>
    <div class="note">${esc((e.comment || '').replace(/^#\s?/gm, ''))}</div>
    <div class="chips">${chips(e)}</div>
    ${actions}
  </div>`;
}
function render() {
  const q = $('q').value.trim().toLowerCase();
  const items = S.entries.map((e, i) => ({ e, i })).filter(({ e }) => e.kind !== 'comment' && L.matchesSearch(e, q));
  const sites = L.sortItems(items.filter(({ e }) => e.kind === 'site'), sortMode);
  const other = L.sortItems(items.filter(({ e }) => e.kind !== 'site'), sortMode);
  let h = '';
  if (S.lossless === false) h += `<div class="banner warn"><span>Diese Caddyfile lässt sich hier nicht verlustfrei darstellen, zum Beispiel wegen einer fehlenden Klammer. Die Karten sind deshalb nur zum Lesen da.</span><button class="sm" data-act="toRaw">Im Rohtext bearbeiten</button></div>`;
  h += `<h2>Sites (${sites.length})</h2>`;
  h += sites.length ? `<div class="grid ${view}">${sites.map(({ e, i }) => card(e, i)).join('')}</div>` : `<div class="empty">${q ? 'Nichts gefunden.' : 'Noch keine Einträge. Lege oben den ersten an.'}</div>`;
  if (other.length) h += `<h2>Global &amp; Snippets</h2><div class="grid ${view}">${other.map(({ e, i }) => card(e, i)).join('')}</div>`;
  $('cards').innerHTML = h;
}
// Bildfehler melden sich nicht bis nach oben: deshalb in der Capture-Phase abfangen.
$('cards').addEventListener('error', (ev) => { if (ev.target.matches && ev.target.matches('img.ico')) ev.target.outerHTML = ev.target.dataset.ph; }, true);

function showConflict(message) {
  $('conflictText').textContent = message + (rawDirty ? ' Dein Rohtext-Entwurf bleibt erhalten; speicherst du ihn danach, überschreibt er den neuen Stand.' : '');
  $('conflict').hidden = false;
}
$('conflictLoad').onclick = async () => {
  $('conflict').hidden = true;
  await load();
  rawBase = S.hash; // ab jetzt bewusst: Der Entwurf darf den neuen Stand überschreiben
  syncRaw();
};

// ----- Reiter -----
function setTab(name) {
  const raw = name === 'raw';
  $('tabCards').className = raw ? '' : 'on';
  $('tabRaw').className = raw ? 'on' : '';
  $('cards').hidden = raw;
  $('rawView').hidden = !raw;
  for (const id of ['viewSeg', 'sortWrap', 'q', 'add']) $(id).hidden = raw;
}
$('tabCards').onclick = () => setTab('cards');
$('tabRaw').onclick = () => setTab('raw');

// ----- Rohtext -----
function syncRaw() {
  $('saveRaw').textContent = S.canReload ? 'Speichern & Neu laden' : 'Speichern';
  $('rawHint').textContent = rawDirty ? (rawBase === S.hash ? 'Ungespeicherte Änderungen.' : 'Ungespeicherte Änderungen auf einem älteren Stand der Datei.')
    : S.canReload || S.canValidate ? 'Ganze Datei bearbeiten – wird vor dem Speichern geprüft.'
    : 'Ganze Datei bearbeiten – keine Prüfung möglich (kein caddy-Programm, keine Admin-API).';
  $('rawHint').classList.toggle('dirty', rawDirty);
  $('discardRaw').hidden = !rawDirty;
}
function setRawText(text) { // Entwurf neu aufsetzen, auf dem aktuellen Stand
  $('raw').value = text;
  rawDirty = text !== S.raw;
  rawBase = S.hash;
  syncRaw();
}
$('raw').oninput = () => {
  rawDirty = $('raw').value !== S.raw;
  if (!rawDirty) rawBase = S.hash;
  syncRaw();
};
$('discardRaw').onclick = () => setRawText(S.raw);
$('saveRaw').onclick = async () => {
  $('saveRaw').disabled = true;
  try {
    const r = await api('PUT', '/api/raw', { text: $('raw').value, hash: rawBase });
    rawDirty = false;
    setState(r.state);
    showResult(r, 'Gespeichert');
  } catch (e) {
    if (e.status === 409) showConflict(e.message); else toast(e.message, 'err', 0);
  } finally { $('saveRaw').disabled = false; }
};

// ----- Backups -----
$('openBackups').onclick = async () => {
  try {
    const { files } = await api('GET', '/api/backups');
    $('bakList').innerHTML = files.length
      ? files.map((f) => `<li><span>${esc(L.backupLabel(f))}</span><button class="sm" type="button" data-name="${esc(f)}">In den Rohtext laden</button></li>`).join('')
      : '<li class="hint">Noch keine Backups vorhanden.</li>';
    $('bak').showModal();
  } catch (e) { toast(e.message, 'err', 0); }
};
$('bakClose').onclick = () => $('bak').close();
$('bakList').onclick = async (ev) => {
  const b = ev.target.closest('button[data-name]'); if (!b) return;
  if (rawDirty && !confirm('Dein Rohtext-Entwurf wird durch das Backup ersetzt. Fortfahren?')) return;
  try {
    const { text } = await api('GET', '/api/backups/' + encodeURIComponent(b.dataset.name));
    setRawText(text);
    $('bak').close();
    setTab('raw');
    toast('Backup als Entwurf geladen. Es ist noch nicht gespeichert: Prüfe es und speichere es, um es wiederherzustellen.', 'warn', 9000);
  } catch (e) { toast(e.message, 'err', 0); }
};

// ----- Eintrags-Dialog -----
const PRESETS = {
  proxy: { label: 'Ziel (IP:Port oder URL)', ph: '192.168.1.20:8080', body: (t) => `reverse_proxy ${t || 'IP:PORT'}` },
  static: { label: 'Ordner (root)', ph: '/srv/www', body: (t) => `root * ${t || '/srv/www'}\nfile_server` },
  redir: { label: 'Weiterleiten nach', ph: 'https://example.com{uri}', body: (t) => `redir ${t || 'https://example.com{uri}'}` },
  custom: null,
};
function applyPreset() {
  const p = PRESETS[$('preset').value];
  $('targetRow').hidden = !p;
  if (p) { $('targetLabel').textContent = p.label; $('target').placeholder = p.ph; }
  if (!bodyTouched) $('body').value = p ? p.body($('target').value.trim()) : '';
}
$('preset').onchange = applyPreset;
$('target').oninput = () => { const p = PRESETS[$('preset').value]; if (p && editing === -1 && !bodyTouched) $('body').value = p.body($('target').value.trim()); };
$('body').addEventListener('input', () => { bodyTouched = true; });

function syncAuth() { $('authFields').hidden = !$('authOn').checked; }
$('authOn').onchange = () => { syncAuth(); if ($('authOn').checked) $('authUser').focus(); };

const FORM_FIELDS = ['preset', 'header', 'target', 'authUser', 'authPass', 'body', 'comment'];
const formValues = () => JSON.stringify([FORM_FIELDS.map((id) => $(id).value), $('authOn').checked]);
const formDirty = () => $('dlg').open && formValues() !== formClean;
function formError(msg) { $('formErr').textContent = msg; $('formErr').hidden = !msg; }
function closeFormAsking() { if (!formDirty() || confirm('Deine Änderungen verwerfen?')) $('dlg').close(); }

function openEdit(i) {
  const e = i === -1 ? { kind: 'site', header: '', body: '', comment: '' } : S.entries[i];
  if (e.kind === 'raw' && e.header.includes('\n')) { setTab('raw'); toast('Diese Zeile geht über mehrere Zeilen. Bitte im Rohtext bearbeiten.', 'warn'); return; }
  editing = i; editBase = e; bodyTouched = false;
  formError(''); $('ok').disabled = false;
  $('dlgTitle').textContent = i === -1 ? 'Neuer Eintrag' : e.kind === 'global' ? 'Globale Optionen' : e.kind === 'raw' ? 'Zeile bearbeiten' : 'Eintrag bearbeiten';
  $('presetRow').hidden = i !== -1; $('targetRow').hidden = i !== -1;
  $('addrRow').hidden = e.kind === 'global';
  $('header').value = e.header || ''; $('body').value = e.body || ''; $('comment').value = (e.comment || '').replace(/^#\s?/gm, '');
  $('body').closest('div').hidden = e.kind === 'raw';
  // Basic-Auth-Schalter (globale Optionen und Rohzeilen haben keinen: dort bleibt der Inhalt, wie er ist)
  const hasAuthRow = e.kind === 'site' || e.kind === 'snippet';
  const sa = hasAuthRow ? L.splitAuth(e.body || '') : { rest: e.body || '', auth: null, complex: false };
  $('authRow').hidden = !hasAuthRow;
  authHash = sa.auth ? sa.auth.hash : '';
  if (sa.auth) $('body').value = sa.rest;
  $('authOn').checked = !!sa.auth; $('authOn').disabled = sa.complex;
  $('authUser').value = sa.auth ? sa.auth.user : ''; $('authPass').value = '';
  $('authPass').placeholder = sa.auth ? 'leer lassen = Passwort behalten' : 'Passwort';
  $('authHint').hidden = !sa.complex;
  $('authHint').textContent = sa.complex ? 'Der Inhalt enthält bereits ein komplexeres basic_auth (mehrere Benutzer, Matcher o. Ä.) – bitte direkt im Inhalt bearbeiten.' : '';
  syncAuth();
  if (i === -1) { $('preset').value = 'proxy'; $('target').value = ''; applyPreset(); }
  formClean = formValues();
  $('dlg').showModal(); setTimeout(() => (e.kind === 'global' ? $('body') : $('header')).focus(), 30);
}

// Die Caddyfile wurde anderswo geändert: neuen Stand holen, die Eingabe bleibt im Dialog.
// Gibt zurück, ob erneutes Speichern möglich ist.
async function resolveConflict(e) {
  await load();
  if (S.lossless === false) { formError(e.message); return false; }
  if (editing === -1) { formError('Die Caddyfile wurde anderswo geändert. Der neue Stand ist geladen, „Speichern“ legt deinen Eintrag darin an.'); return true; }
  const idx = L.findEntry(S.entries, editBase);
  if (idx === -1) {
    formError('Dieser Eintrag wurde anderswo geändert oder gelöscht. Kopiere deine Eingabe, schließe den Dialog und öffne den Eintrag neu.');
    return false;
  }
  editing = idx;
  formError('Die Caddyfile wurde anderswo geändert. Der neue Stand ist geladen, „Speichern“ übernimmt deine Eingabe darin.');
  return true;
}

async function submitEntry() {
  const base = editing === -1 ? { kind: 'site' } : editBase;
  const header = L.normalizeHeader(base.kind, $('header').value);
  if (base.kind !== 'global' && !header) { formError('Bitte eine Adresse angeben.'); $('header').focus(); return; }
  if (editing === -1 && PRESETS[$('preset').value] && !bodyTouched && !$('target').value.trim()) {
    formError(`Bitte „${$('targetLabel').textContent}“ ausfüllen oder den Inhalt von Hand schreiben.`);
    $('target').focus();
    return;
  }
  let bodyText = $('body').value;
  if (!$('authRow').hidden && !$('authOn').disabled && $('authOn').checked) {
    const user = $('authUser').value.trim(), pass = $('authPass').value;
    if (!user || /\s/.test(user)) { formError('Bitte einen Benutzernamen ohne Leerzeichen angeben.'); return; }
    let hashed = authHash;
    if (pass) hashed = (await api('POST', '/api/hash', { password: pass })).hash;
    if (!hashed) { formError('Bitte ein Passwort angeben.'); return; }
    bodyText = L.withAuth(user, hashed, bodyText);
  }
  const entry = { ...base, header: base.kind === 'global' ? '' : header, body: bodyText, comment: $('comment').value.trim() };
  const list = S.entries.slice();
  if (editing === -1) list.push(entry); else list[editing] = entry;
  const r = await api('PUT', '/api/entries', { entries: list, hash: S.hash });
  const okMsg = editing === -1 ? 'Eintrag angelegt' : 'Eintrag gespeichert';
  setState(r.state);
  $('dlg').close();
  showResult(r, okMsg);
}
$('form').onsubmit = async (ev) => {
  ev.preventDefault();
  if ($('ok').disabled) return;
  formError('');
  $('ok').disabled = true;
  let locked = false;
  try { await submitEntry(); }
  catch (e) {
    if (e.status === 409) locked = !(await resolveConflict(e));
    else formError(e.message);
  }
  $('ok').disabled = locked;
};
$('cancel').onclick = closeFormAsking;
// Esc: Der Browser kann die Absage übergehen (cancelable = false ohne vorherige Nutzereingabe, oder beim zweiten Esc).
// Dann schließt er danach trotzdem, und der Dialog geht mit erhaltenen Feldern wieder auf.
$('dlg').addEventListener('cancel', (ev) => {
  ev.preventDefault();
  closeFormAsking();
  if ($('dlg').open && !ev.cancelable) setTimeout(() => { if (!$('dlg').open) $('dlg').showModal(); });
});
$('add').onclick = () => openEdit(-1);

// ----- Löschen -----
let delIdx = null;
$('cards').onclick = (ev) => {
  const b = ev.target.closest('button[data-act]'); if (!b) return;
  if (b.dataset.act === 'toRaw') return setTab('raw');
  const i = +b.closest('.card').dataset.i;
  if (b.dataset.act === 'edit') openEdit(i);
  else { delIdx = i; const e = S.entries[i]; $('delText').innerHTML = `<b>${esc(e.header || 'Globale Optionen')}</b> wird aus der Caddyfile entfernt.`; $('del').showModal(); }
};
$('delNo').onclick = () => $('del').close();
$('delYes').onclick = async (ev) => {
  ev.preventDefault();
  $('delYes').disabled = true;
  const l = S.entries.slice(); l.splice(delIdx, 1);
  try {
    const r = await api('PUT', '/api/entries', { entries: l, hash: S.hash });
    setState(r.state);
    $('del').close();
    showResult(r, 'Eintrag gelöscht');
  } catch (e) {
    $('del').close();
    if (e.status === 409) showConflict(e.message); else toast(e.message, 'err', 0);
  } finally { $('delYes').disabled = false; }
};

// ----- Bedienelemente -----
$('q').oninput = render;
$('sort').value = sortMode;
$('sort').onchange = () => { sortMode = $('sort').value; localStorage.setItem('caddit-sort', sortMode); render(); };
function setView(v) { view = v; localStorage.setItem('caddit-view', v || 'cards'); $('vCards').className = v ? '' : 'on'; $('vList').className = v ? 'on' : ''; render(); }
$('vCards').onclick = () => setView(''); $('vList').onclick = () => setView('list');
setView(view);
const tabInserts = (e) => { if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '\t'); } };
$('raw').addEventListener('keydown', tabInserts);
$('body').addEventListener('keydown', tabInserts);
window.addEventListener('beforeunload', (e) => { if (rawDirty || formDirty()) e.preventDefault(); });
load();
