// The review UI: a green desk with the week printed as a receipt. Everything comes from the local server.

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const linearLink = l => /^https?:\/\//i.test(l?.url ?? '') ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.identifier)}</a>` : esc(l?.identifier);
const DAYN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dname = d => DAYN[new Date(`${d}T12:00:00`).getDay()];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pretty = d => { const x = new Date(`${d}T12:00:00`); return `${MON[x.getMonth()]} ${x.getDate()}`; };
const fmt = h => (h == null ? '—' : Number(h).toFixed(1));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHEV = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m2.5 4.5 3.5 3.5 3.5-3.5"/></svg>';
const PREV = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>';
const NEXT = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>';
const TEXT_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

function weekDays(week) {
  const [y, w] = week.split('-W').map(Number);
  const j4 = new Date(Date.UTC(y, 0, 4));
  const mon = new Date(j4);
  mon.setUTCDate(j4.getUTCDate() - ((j4.getUTCDay() + 6) % 7) + (w - 1) * 7);
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setUTCDate(mon.getUTCDate() + i); return d.toISOString().slice(0, 10); });
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - dow + 3);
  const y = t.getUTCFullYear(); const j4 = new Date(Date.UTC(y, 0, 4));
  return `${y}-W${String(1 + Math.round(((t - j4) / 86400000 - 3 + ((j4.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
}
const shiftWeek = (week, n) => { const [y, w] = week.split('-W').map(Number); return isoWeek(new Date(Date.UTC(y, 0, 4 + (w - 1) * 7 + n * 7))); };
const weekNo = week => Number(week.split('-W')[1]);

// ---------- state ----------
const state = {
  week: new URLSearchParams(location.search).get('week'),
  draft: null, base: null, weeks: [], projects: [], warnings: [], push: { status: 'idle' },
  tab: 'week', sel: null, mergeFrom: null, armedDelete: null, collapsed: new Set(), flash: new Set(), fed: false,
  adding: false, addProject: null, addDay: null,
  everhour: undefined, // undefined: still asking, null: couldn't read, number: hours
  saving: false, saveFailed: false, saveError: null, busy: null, toast: '', help: false,
  picked: new Set(), pickAnchor: null, // issues picked for a bulk change; `sel` stays the one in the editor
  modal: null, modalReturn: null, // { kind: 'palette' | 'confirm' | 'assist', ... }
  openSel: null, selActive: 0,
  print: null, settings: null, settingsSaving: false, history: null, loadError: null,
};

async function api(method, url, body, signal) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, body: j });
  return j;
}

let toastTimer = null;
function toast(msg) {
  state.toast = msg; renderToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = ''; renderToast(); }, 4000);
}

// ---------- draft data ----------
const live = () => state.draft.items.filter(i => !i.deleted);
const findItem = id => state.draft?.items.find(i => i.id === id && !i.deleted);
const projectNames = () => state.projects.map(p => p.name);
const kindOf = name => state.projects.find(p => p.name === name)?.kind;
const isPushed = i => !!i.linear?.created; // read-only everywhere
const isFrozen = i => !!i.linear; // the server refuses hours, split, merge and delete once a Linear id exists
const color = p => { const k = projectNames().indexOf(p); return k < 0 ? 'var(--bad-ink)' : `var(--p${(k % 6) + 1})`; };
const parentTitle = (day, project) => state.draft.parents.find(p => p.key === `${day}|${project}`)?.title || `${dname(day)} — ${project}`;
const unlogged = () => live().filter(i => !i.everhour?.logged);
const blocks = () => state.warnings.filter(w => w.level === 'block');

function groupedDays() {
  const act = live();
  const counted = state.draft.days;
  const order = [...projectNames()];
  const rank = k => (k === '' ? 1e6 : order.includes(k) ? order.indexOf(k) : 1e5);
  const days = [...new Set([...counted, ...act.map(i => i.day)])].sort();
  return days.map(day => {
    const its = act.filter(i => i.day === day);
    const keys = [...new Set(its.map(i => i.project ?? ''))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return { day, counted: counted.includes(day), total: its.reduce((s, i) => s + (i.hours ?? 0), 0), count: its.length, groups: keys.map(k => ({ key: k, items: its.filter(i => (i.project ?? '') === k) })) };
  }).filter(d => d.counted || d.count);
}
const receiptOrder = () => groupedDays().flatMap(d => d.groups.flatMap(g => g.items));
const visibleLines = () => groupedDays().filter(d => !state.collapsed.has(d.day)).flatMap(d => d.groups.flatMap(g => g.items));

// ---------- loading and saving ----------
function accept(res, draft = res.draft) {
  const before = new Map((state.draft?.week === res.draft.week ? state.draft.items : []).map(i => [i.id, i.hours]));
  state.draft = draft;
  state.base = structuredClone(res.draft);
  state.warnings = res.warnings;
  const changed = res.draft.items.filter(i => before.has(i.id) && before.get(i.id) !== i.hours).map(i => i.id);
  if (changed.length) { state.flash = new Set(changed); setTimeout(() => { state.flash = new Set(); }, 1100); }
  if (!findItem(state.sel)) state.sel = live().find(i => !isPushed(i))?.id ?? live()[0]?.id ?? null;
  for (const id of state.picked) if (!findItem(id)) state.picked.delete(id);
  render();
}

async function load(week) {
  const s = await api('GET', `/api/state${week ? `?week=${week}` : ''}`);
  const fresh = !state.draft || s.week !== state.week;
  if (s.week !== state.week) {
    state.sel = null; state.mergeFrom = null; state.armedDelete = null; state.adding = false; state.collapsed = new Set(); state.fed = false;
    state.picked = new Set(); state.pickAnchor = null; state.modal = null;
    if (state.print && state.print.week !== s.week) state.print = null;
  }
  state.week = s.week; state.weeks = s.weeks; state.projects = s.projects; state.push = s.push; state.loadError = null;
  history.replaceState(null, '', `?week=${s.week}`);
  if (fresh && !state.print && (s.push.status === 'running' || s.push.status === 'awaiting_sync')) state.print = newPrint(s.draft, 'server');
  accept(s);
  if (s.push.status === 'running') pollPush();
  loadEverhour(s.week);
}

function loadEverhour(week) {
  state.everhour = undefined;
  api('GET', `/api/everhour?week=${week}`)
    .then(r => { if (state.week === week) { state.everhour = r.hours; render(); } })
    .catch(() => { if (state.week === week) { state.everhour = null; render(); } });
}

const FIELDS = ['title', 'description', 'project', 'day', 'locked'];
/** Field edits in `draft` that `base` doesn't have yet. */
function diffEdits(draft, base) {
  const byId = new Map(base.items.map(i => [i.id, i]));
  const out = [];
  for (const i of draft.items) {
    const b = byId.get(i.id);
    if (!b) continue;
    const patch = {};
    for (const f of FIELDS) if (JSON.stringify(i[f]) !== JSON.stringify(b[f])) patch[f] = i[f];
    if (Object.keys(patch).length) out.push([i.id, patch]);
  }
  const top = {};
  if (draft.totalHours !== base.totalHours) top.totalHours = draft.totalHours;
  if (JSON.stringify(draft.days) !== JSON.stringify(base.days)) top.days = draft.days;
  return { items: out, top };
}
const pendingPatches = () => diffEdits(state.draft, state.base);

/** Copies field edits onto a draft (never onto pushed items). */
function applyEdits(target, edits) {
  for (const [id, patch] of edits.items) { const it = target.items.find(x => x.id === id); if (it && !it.linear?.created) Object.assign(it, patch); }
  Object.assign(target, edits.top);
  return target;
}

/** Accepts a server response without losing edits typed while the request was in flight (`sent` is what we had when it left). */
function acceptCarrying(res, sent) {
  const late = diffEdits(state.draft, sent);
  if (!late.items.length && !Object.keys(late.top).length) return accept(res);
  accept(res, applyEdits(structuredClone(res.draft), late));
  scheduleSave();
}
const hasPending = () => { if (!state.draft) return false; const p = pendingPatches(); return p.items.length > 0 || Object.keys(p.top).length > 0; };

let saveTimer = null, retryTimer = null, inflight = null;
function scheduleSave(ms = 400) { clearTimeout(saveTimer); saveTimer = setTimeout(save, ms); renderTop(); }

/**
 * Saves pending edits. Only one save runs at a time: a call made while one is in flight gets the same promise,
 * and the running save goes round again (at most twice more) if edits are still pending when its PUT returns.
 * Resolves true when everything is saved. A failure leaves the edits pending, shows "Unsaved" and retries in ~2 s
 * (a 423 keeps retrying quietly until the push finishes).
 */
function save() {
  clearTimeout(saveTimer);
  clearTimeout(retryTimer);
  if (inflight) return inflight;
  inflight = (async () => {
    let ok = true;
    try {
      for (let round = 0; ok && hasPending() && round < 3; round++) ok = await saveOnce();
    } finally {
      inflight = null;
      state.saving = false;
    }
    state.saveFailed = !ok;
    if (!ok) retryTimer = setTimeout(save, 2000);
    renderTop();
    return ok;
  })();
  return inflight;
}

/** One PUT /api/draft, with the single re-apply-and-retry on 409. Returns false on failure. */
async function saveOnce() {
  state.saving = true; renderTop();
  try {
    let sent = structuredClone(state.draft);
    try {
      acceptCarrying(await api('PUT', '/api/draft', { draft: sent }), sent);
    } catch (e) {
      const server = e.body?.draft;
      if (e.status !== 409 || !server) throw e;
      const fresh = applyEdits(structuredClone(server), diffEdits(state.draft, state.base)); // includes anything typed meanwhile
      state.base = structuredClone(server);
      state.draft = fresh;
      toast('The draft changed elsewhere. Your edits were re-applied.');
      sent = structuredClone(fresh);
      acceptCarrying(await api('PUT', '/api/draft', { draft: sent }), sent); // one retry only; state.saving stays true
    }
    state.saveError = null;
    return true;
  } catch (e) {
    // say it once; the automatic retries stay quiet unless the reason changes (a 423 just shows its message)
    if (!state.saveFailed || state.saveError !== e.message) toast(e.status === 423 ? e.message : `Not saved: ${e.message} Retrying.`);
    state.saveError = e.message;
    return false;
  }
}

/** POSTs an edit for this week after pending edits are saved. Returns the new draft on success, null on failure. */
async function act(url, body) {
  if (!(await save())) return null; // posting now would drop the unsaved edits
  const sent = structuredClone(state.draft);
  try {
    const res = await api('POST', url, { week: state.week, ...body });
    acceptCarrying(res, sent);
    return res.draft;
  } catch (e) {
    if (e.status === 409) await load(state.week).catch(() => {});
    toast(e.message);
    return null;
  }
}

/** Changes a field that travels through PUT /api/draft. Text fields skip the re-render: the input already shows the value. */
function setField(it, field, value, rerender = true) {
  if (!it || isPushed(it)) return;
  it[field] = value;
  scheduleSave();
  if (rerender) render();
}

// ---------- line actions ----------
async function distribute(reweight) {
  if (state.busy) return;
  state.busy = reweight ? 'reweight' : 'itemise'; render();
  const d = await act('/api/distribute', { reweight });
  state.busy = null; render();
  if (d) toast(reweight ? 'Effort re-estimated and hours itemised.' : 'Hours itemised.');
}
function stepHours(it, delta, floorFrom) {
  if (!it || isFrozen(it)) return;
  return act('/api/hours', { id: it.id, hours: Math.max(0.5, (it.hours ?? floorFrom) + delta) });
}
async function splitLine(it) {
  if (!it || isFrozen(it)) return;
  if (await act('/api/split', { id: it.id, parts: 2 })) { state.sel = `${it.id}-1`; render(); toast('Split in two. Press Itemise to give them hours.'); }
}
async function mergeInto(firstId, otherId) {
  state.mergeFrom = null;
  if (await act('/api/merge', { ids: [firstId, otherId] })) { state.sel = firstId; render(); toast('Merged.'); }
}
async function deleteLine(it) {
  if (!it || isFrozen(it)) return;
  if (state.armedDelete !== it.id) { state.armedDelete = it.id; render(); toast('Press again to delete this issue.'); return; }
  state.armedDelete = null;
  if (await act('/api/delete', { id: it.id })) toast("Issue deleted. /timesheet won't redraft it.");
}
function toggleMark(it) {
  if (!it || isFrozen(it)) return;
  if (state.mergeFrom && state.mergeFrom !== it.id) return mergeInto(state.mergeFrom, it.id);
  state.mergeFrom = it.id; render(); toast('Marked. Press m on another issue to merge.');
}
function selectLine(id, scroll = true) {
  const line = findItem(id);
  if (!line) return;
  state.collapsed.delete(line.day);
  state.sel = id; state.armedDelete = null;
  render();
  if (scroll) document.querySelector(`.r-line[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function openAdd() {
  if (state.tab !== 'week' || state.print) return;
  state.adding = true; state.addProject = null; state.addDay = null; render();
  $('#add-title')?.focus();
}
async function submitAdd() {
  const title = $('#add-title').value.trim();
  if (!title) return toast('Give the issue a title.');
  const days = state.draft.days.length ? state.draft.days : weekDays(state.week);
  const before = new Set(state.draft.items.map(i => i.id));
  const d = await act('/api/items', { title, description: $('#add-desc').value, project: state.addProject ?? projectNames()[0] ?? null, day: state.addDay ?? findItem(state.sel)?.day ?? days[0] });
  if (!d) return;
  state.adding = false;
  state.sel = d.items.find(i => !before.has(i.id))?.id ?? state.sel;
  render(); toast('Issue added. Press Itemise to give it hours.');
}

// ---------- picking several issues ----------
const pickedItems = () => receiptOrder().filter(i => state.picked.has(i.id));
/** Shift picks the range from the last picked issue, in receipt order. */
function togglePick(id, range = false) {
  const order = visibleLines().map(i => i.id);
  if (range && state.pickAnchor && order.includes(state.pickAnchor) && order.includes(id)) {
    const [a, b] = [order.indexOf(state.pickAnchor), order.indexOf(id)].sort((x, y) => x - y);
    for (const x of order.slice(a, b + 1)) state.picked.add(x);
  } else if (state.picked.has(id)) state.picked.delete(id);
  else state.picked.add(id);
  state.pickAnchor = id;
  render();
}
function pickDay(day) {
  const ids = live().filter(i => i.day === day).map(i => i.id);
  const all = ids.every(id => state.picked.has(id));
  for (const id of ids) { if (all) state.picked.delete(id); else state.picked.add(id); }
  render();
}
function clearPicked() { state.picked = new Set(); state.pickAnchor = null; render(); }

/** POST /api/bulk after pending edits are saved. Returns the response, or null after saying why it failed. */
async function bulk(ops, rev) {
  if (!(await save())) return null;
  const sent = structuredClone(state.draft);
  try {
    const res = await api('POST', '/api/bulk', { week: state.week, rev: rev ?? state.base.rev, ops });
    acceptCarrying(res, sent);
    return res;
  } catch (e) {
    if (e.status === 409) { await load(state.week).catch(() => {}); toast(rev != null ? 'The week changed while Claude was thinking. Ask again.' : e.message); } else toast(e.message);
    return null;
  }
}
async function bulkSet(field, value) {
  const ids = pickedItems().map(i => i.id);
  if (!ids.length) return;
  const res = await bulk([{ op: 'set', ids, [field]: value }]);
  if (res) toast(`${res.summary.join('. ')}.`);
}
async function doMerge(ids) {
  const res = await bulk([{ op: 'merge', ids }]);
  if (!res) return false;
  state.sel = ids[0]; state.picked = new Set(); render();
  toast(`Merged ${plural(ids.length, 'issue')}.`);
  return true;
}
function bulkMerge() {
  const its = pickedItems();
  if (its.length < 2) return toast('Pick at least 2 issues to merge.');
  const [first] = its;
  if (its.every(i => i.day === first.day && i.project === first.project)) return doMerge(its.map(i => i.id));
  openModal({
    kind: 'confirm', title: `Merge ${plural(its.length, 'issue')}?`, ok: 'Merge',
    body: `<p>They become one issue, <strong>${esc(first.title)}</strong>, on ${dname(first.day)} in ${esc(first.project ?? 'no project')}.</p><p class="m-faint">The others are on a different day or project, so they move there.</p>`,
    run: () => doMerge(its.map(i => i.id)),
  });
}

/** Deletes issues after a confirm. Pushed ones are also trashed in Linear and their hours cleared in Everhour. */
function requestDelete(ids) {
  const its = ids.map(findItem).filter(Boolean);
  if (!its.length) return;
  const pushed = its.filter(isFrozen), local = its.filter(i => !isFrozen(i));
  const gone = new Set(its.map(i => i.id));
  const emptied = [...new Set(pushed.filter(i => i.project).map(i => `${i.day}|${i.project}`))]
    .filter(key => live().every(i => `${i.day}|${i.project}` !== key || gone.has(i.id)))
    .map(key => state.draft.parents.find(p => p.key === key)).filter(p => p?.linear);
  const row = i => `<li><span class="m-id">${esc(i.linear?.identifier ?? '·····')}</span><span class="m-t">${esc(i.title)}</span><span class="m-h">${i.everhour?.logged ? `${fmt(i.hours)} h · ${dname(i.day).slice(0, 3)}` : 'no hours yet'}</span></li>`;
  let localDone = !local.length;
  openModal({
    kind: 'confirm', danger: true, focusCancel: pushed.length > 0,
    title: `Delete ${plural(its.length, 'issue')}?`,
    ok: pushed.length ? 'Delete from Linear and Everhour' : `Delete ${plural(its.length, 'issue')}`,
    body: [
      local.length ? `<p>${local.length === its.length ? (local.length === 1 ? 'It comes' : 'They come') : `${plural(local.length, 'issue')} come`} off this week. /timesheet won't draft ${local.length === 1 ? 'it' : 'them'} again.</p>` : '',
      pushed.length ? `<p>${pushed.length === 1 ? (its.length === 1 ? 'It is' : 'One is') : `${pushed.length === its.length ? '' : 'These '}${plural(pushed.length, 'issue')} are`} already printed. ${pushed.length === 1 ? 'It goes' : 'Each one goes'} to Linear's trash (you can restore it there for 30 days) and its hours are cleared in Everhour:</p><ul class="m-list">${pushed.map(row).join('')}</ul>` : '',
      emptied.length ? `<p>That leaves ${emptied.length === 1 ? 'a parent' : 'parents'} with nothing under ${emptied.length === 1 ? 'it' : 'them'}, so ${emptied.map(p => `<strong>${esc(p.linear.identifier ?? p.title)}</strong>`).join(', ')} ${emptied.length === 1 ? 'goes' : 'go'} to the trash too.</p>` : '',
    ].join(''),
    run: async () => {
      if (!localDone) {
        if (!(await bulk([{ op: 'delete', ids: local.map(i => i.id) }]))) return false;
        localDone = true;
      }
      if (pushed.length) return removeRemote(pushed.map(i => i.id));
      toast(`Deleted ${plural(local.length, 'issue')}. /timesheet won't redraft ${local.length === 1 ? 'it' : 'them'}.`);
      return true;
    },
  });
}
async function removeRemote(ids) {
  if (!(await save())) return false;
  const sent = structuredClone(state.draft);
  try {
    const res = await api('POST', '/api/remove', { week: state.week, ids, confirm: true });
    acceptCarrying(res, sent);
    loadEverhour(state.week);
    if (res.failed.length) {
      const name = id => { const i = state.draft.items.find(x => x.id === id); return i ? (i.linear?.identifier ?? i.title) : `the parent for ${id.replace('|', ', ')}`; };
      if (state.modal) { state.modal.error = res.failed.map(f => `${name(f.id)}: ${f.error}`); state.modal.ok = 'Try again'; }
      if (res.removed.length) toast(`Deleted ${plural(res.removed.length, 'issue')}. ${plural(res.failed.length, 'step')} failed.`);
      return false;
    }
    toast(`Deleted ${plural(res.removed.length, 'issue')} from Linear and Everhour${res.parents.length ? `, plus ${plural(res.parents.length, 'empty parent')}` : ''}.`);
    return true;
  } catch (e) {
    if (state.modal) { state.modal.error = [e.message]; state.modal.ok = 'Try again'; }
    return false;
  }
}

// ---------- modal: confirm, command palette, Ask Claude ----------
function openModal(m) {
  if (!state.modal) state.modalReturn = document.activeElement?.id || null;
  state.modal = m; state.help = false; state.openSel = null;
  render();
  focusModal();
}
function focusModal() {
  const m = state.modal;
  if (!m) return;
  const want = m.kind === 'palette' ? '#paletteinput' : m.kind === 'assist' ? (m.status === 'answer' ? '#assist-apply' : m.status === 'thinking' ? '#assist-cancel' : '#assistinput') : m.focusCancel ? '#modal-cancel' : '#modal-ok';
  (document.querySelector(want) ?? document.querySelector('.modal button'))?.focus();
}
function closeModal() {
  const m = state.modal;
  if (!m || m.busy) return;
  m.ctl?.abort();
  state.modal = null;
  render();
  if (state.modalReturn) document.getElementById(state.modalReturn)?.focus();
}
async function runConfirm() {
  const m = state.modal;
  if (!m || m.kind !== 'confirm' || m.busy) return;
  m.busy = true; m.error = null; render();
  let ok = false;
  try { ok = await m.run(); } finally { m.busy = false; }
  if (state.modal !== m) return;
  if (ok) closeModal(); else { render(); focusModal(); }
}

const COMMANDS = [
  { id: 'itemise', label: 'Itemise hours', key: 'D', words: 'distribute split total', run: () => distribute(false) },
  { id: 'reweight', label: 'Estimate effort again and itemise', words: 'reweight weights re-estimate', run: () => distribute(true) },
  { id: 'print', label: 'Print to Linear and Everhour', key: 'P', words: 'push send', run: () => { state.tab = 'week'; requestPush(); } },
  { id: 'add', label: 'Add an issue by hand', key: 'a', words: 'new manual', run: () => { if (state.tab !== 'week') switchTab('week'); openAdd(); } },
  { id: 'pick-all', label: 'Pick every issue', words: 'select all bulk', run: () => { state.tab = 'week'; state.picked = new Set(live().map(i => i.id)); render(); } },
  { id: 'week', label: 'This week', words: 'current receipt', run: () => switchTab('week') },
  { id: 'history', label: 'Past weeks', words: 'history', run: () => switchTab('history') },
  { id: 'settings', label: 'Settings', words: 'repos projects orgs reminder', run: () => switchTab('settings') },
  { id: 'help', label: 'Keyboard shortcuts', key: '?', words: 'help keys', run: () => { state.help = true; renderOverlay(); } },
];
function paletteRows(q) {
  const t = q.trim().toLowerCase();
  const rows = [];
  const wk = t.match(/^(?:go to )?week\s+(\d{4}-w\d{2}|last|this|next|previous|prev)$/);
  if (wk) {
    const w = wk[1];
    const target = w === 'next' ? shiftWeek(state.week, 1) : w === 'previous' || w === 'prev' ? shiftWeek(state.week, -1) : w.toUpperCase();
    rows.push({ id: 'goweek', label: `Go to week ${w === 'last' || w === 'this' ? w : weekNo(target)}`, run: () => goWeek(w === 'last' || w === 'this' ? w : target) });
  }
  const words = c => `${c.label} ${c.words}`.toLowerCase().split(/[^a-z0-9?]+/);
  const tokens = t.split(/\s+/).filter(Boolean);
  rows.push(...COMMANDS.filter(c => !tokens.length || tokens.every(tok => words(c).some(w => w.startsWith(tok)))));
  if (t) {
    const ask = { id: 'ask', label: 'Ask Claude', detail: q.trim(), run: () => askClaude(q.trim()) };
    if (rows.length) rows.push(ask); else rows.unshift(ask);
  }
  return rows;
}
function openPalette() {
  if (!state.draft) return;
  openModal({ kind: 'palette', q: '', active: 0 });
}
function runPaletteRow(k) {
  const m = state.modal;
  const row = paletteRows(m.q)[k];
  if (!row) return;
  state.modal = null; render();
  if (row.id !== 'ask' && state.modalReturn) document.getElementById(state.modalReturn)?.focus();
  row.run();
}

async function askClaude(message, turns = []) {
  if (!message) return;
  const m = { kind: 'assist', turns, message, status: 'thinking', reply: '', ops: [], summary: [], remote: [], rev: null, ctl: new AbortController() };
  openModal(m);
  if (!(await save())) { m.status = 'error'; m.reply = `Your edits aren't saved yet (${state.saveError ?? 'unknown error'}), so Claude would see an old week.`; render(); return focusModal(); }
  try {
    const r = await api('POST', '/api/assist', { week: state.week, message, history: turns.slice(-3) }, m.ctl.signal);
    if (state.modal !== m) return;
    Object.assign(m, { status: r.ops.length ? 'answer' : 'note', reply: r.reply, ops: r.ops, summary: r.summary, remote: r.remote, rev: r.rev });
  } catch (e) {
    if (e.name === 'AbortError' || state.modal !== m) return;
    m.status = 'error'; m.reply = e.message;
  }
  render(); focusModal();
}
function followUp(text) {
  const m = state.modal;
  if (!text.trim() || m?.kind !== 'assist') return;
  askClaude(text.trim(), [...m.turns, { message: m.message, reply: m.reply }]);
}
async function applyAssist() {
  const m = state.modal;
  if (m?.kind !== 'assist' || m.status !== 'answer' || !m.ops.length) return;
  m.status = 'applying'; m.busy = true; render();
  const res = await bulk(m.ops, m.rev);
  m.busy = false;
  if (state.modal !== m) return;
  if (!res) { m.status = 'answer'; render(); return focusModal(); }
  state.modal = null; render();
  if (res.remote.length) return requestDelete(res.remote);
  toast(`Done. ${res.summary.join('. ')}.`);
}

// ---------- custom select ----------
const SELS = {};
function select(id, options, value, onPick, opt = {}) {
  SELS[id] = { options, onPick };
  const cur = options.find(o => o.v === value);
  const open = state.openSel === id;
  return `<div class="sel ${opt.paper ? 'on-paper' : ''}">
    <button type="button" class="sel-btn" id="${id}" data-act="sel-toggle" data-sel="${id}" aria-haspopup="listbox" aria-expanded="${open}" ${opt.disabled ? 'disabled' : ''} ${opt.label ? `aria-label="${esc(opt.label)}"` : ''}>
      ${cur?.color ? `<span class="swatch" style="background:${cur.color}"></span>` : ''}
      <span class="lbl ${cur ? '' : 'ph'}">${esc(cur ? cur.label : (opt.placeholder || 'Choose'))}</span>${CHEV}
    </button>
    ${open ? `<ul class="sel-list" role="listbox" aria-labelledby="${id}">${options.map((o, k) => `<li class="sel-opt ${k === state.selActive ? 'active' : ''}" role="option" aria-selected="${o.v === value}" data-act="sel-pick" data-sel="${id}" data-k="${k}">${o.color ? `<span class="swatch" style="background:${o.color}"></span>` : ''}<span>${esc(o.label)}</span>${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ''}</li>`).join('')}</ul>` : ''}
  </div>`;
}
const projectOptions = () => state.projects.map(p => ({ v: p.name, label: p.name, hint: p.kind, color: color(p.name) }));
function pickSel(id, k) {
  const s = SELS[id];
  state.openSel = null;
  if (!s) return render();
  const o = s.options[k];
  if (o) s.onPick(o.v);
  render();
  document.getElementById(id)?.focus();
}

// ---------- render ----------
function render() {
  const ae = document.activeElement;
  const keep = ae && ae.id && ae !== document.body
    ? { id: ae.id, owner: ae.dataset.for, text: TEXT_TAGS.includes(ae.tagName) ? ae.value : undefined, s: ae.selectionStart, e: ae.selectionEnd }
    : null;
  const scroll = [...document.querySelectorAll('[data-keep-scroll]')].map(el => [el.dataset.keepScroll, el.scrollTop]);
  for (const k in SELS) delete SELS[k];
  renderTop(); renderView(); renderOverlay(); renderToast();
  for (const [k, top] of scroll) { const el = document.querySelector(`[data-keep-scroll="${k}"]`); if (el) el.scrollTop = top; }
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el && !el.disabled && el.dataset.for === keep.owner) {
      if (keep.text !== undefined && el.value !== keep.text) el.value = keep.text; // keep what is being typed
      el.focus({ preventScroll: true });
      try { if (keep.s != null) el.setSelectionRange(keep.s, keep.e); } catch { /* not a text field */ }
    }
  }
  if (state.openSel) document.querySelector(`#${state.openSel} + .sel-list .sel-opt.active`)?.scrollIntoView({ block: 'nearest' });
}

function renderTop() {
  const failed = state.saveFailed && hasPending() && !state.saving;
  const busy = !failed && (state.saving || state.settingsSaving || hasPending());
  const onWeek = state.tab === 'week' && !state.print;
  $('#top').innerHTML = `<div class="top-in">
    <span class="brand">my-timesheet</span>
    <span class="spacer"></span>
    <nav class="tabs" aria-label="Sections">${[['week', 'This week'], ['history', 'Past weeks'], ['settings', 'Settings']].map(([k, l]) => `<button class="tab ${state.tab === k && !state.print ? 'on' : ''}" data-act="tab" data-k="${k}">${l}</button>`).join('')}</nav>
    ${onWeek && state.week ? `<div class="weeknav">
      <button class="icon-btn" data-act="prev" aria-label="Previous week">${PREV}</button>
      <span class="weeklabel" title="${esc(state.week)}">Week ${weekNo(state.week)}</span>
      <button class="icon-btn" data-act="next" aria-label="Next week">${NEXT}</button>
    </div>` : ''}
    <span class="saved ${failed ? 'failed' : busy ? 'busy' : ''}" aria-live="polite" ${failed ? `title="${esc(state.saveError ?? '')}"` : ''}>${failed ? 'Unsaved' : busy ? 'Saving' : 'Saved'}</span>
  </div>`;
}
function renderToast() { $('#toast').innerHTML = state.toast ? `<div class="toast" role="status">${esc(state.toast)}</div>` : ''; }

const HELP = [['j / k', 'next / previous issue'], ['e', 'edit the title'], ['p', 'next project'], ['[ / ]', 'half an hour less / more (locks the issue)'], ['L', 'lock or unlock hours'], ['s', 'split in two'], ['m', 'mark, then m on another issue to merge'], ['d d', 'delete the issue'], ['x', 'pick the issue (shift-click picks a range)'], ['a', 'add an issue'], ['D', 'itemise hours'], ['P', 'print to Linear and Everhour'], ['/ or ⌘K', 'commands and Ask Claude'], ['?', 'show or hide this']];
function renderOverlay() {
  const help = state.help ? `<div class="overlay" role="dialog" aria-label="Keyboard shortcuts"><strong>Keyboard</strong><dl>${HELP.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>` : '';
  $('#overlay').innerHTML = help + renderModal();
  document.querySelector('.pal-row.active')?.scrollIntoView({ block: 'nearest' });
}

const SPARK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0c.4 3.9 2.1 5.6 6 6-3.9.4-5.6 2.1-6 6-.4-3.9-2.1-5.6-6-6 3.9-.4 5.6-2.1 6-6Zm5 10c.2 1.9 1 2.8 3 3-2 .2-2.8 1-3 3-.2-2-1-2.8-3-3 2-.2 2.8-1.1 3-3Z"/></svg>';
function renderModal() {
  const m = state.modal;
  if (!m) return '';
  const inner = m.kind === 'palette' ? renderPalette(m) : m.kind === 'assist' ? renderAssist(m) : renderConfirm(m);
  return `<div class="modal-back" data-act="modal-back"></div>
    <div class="modal ${m.kind}${m.danger ? ' danger' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">${inner}</div>`;
}
function renderConfirm(m) {
  return `<div class="m-head"><h2 id="modal-title">${esc(m.title)}</h2></div>
    <div class="m-body">${m.body}${m.error ? `<div class="m-error" role="alert">${m.error.map(x => `<div>✗ ${esc(x)}</div>`).join('')}</div>` : ''}</div>
    <div class="m-foot">
      <button class="paper-btn" id="modal-cancel" data-act="modal-cancel" ${m.busy ? 'disabled' : ''}>Cancel</button>
      <button class="paper-btn solid ${m.danger ? 'danger' : ''}" id="modal-ok" data-act="modal-ok" ${m.busy ? 'disabled' : ''}>${m.busy ? 'Working…' : esc(m.ok)}</button>
    </div>`;
}
function renderPalette(m) {
  const rows = paletteRows(m.q);
  m.active = Math.min(m.active, Math.max(0, rows.length - 1));
  const list = rows.map((r, k) => `<li class="pal-row ${k === m.active ? 'active' : ''} ${r.id === 'ask' ? 'ask' : ''}" role="option" id="pal-${k}" aria-selected="${k === m.active}" data-act="pal-run" data-k="${k}">
      ${r.id === 'ask' ? `<span class="pal-ico">${SPARK}</span><span class="pal-l">Ask Claude <span class="pal-q">“${esc(r.detail)}”</span></span><span class="kbd">↵</span>` : `<span class="pal-l">${esc(r.label)}</span>${r.key ? `<span class="kbd">${esc(r.key)}</span>` : ''}`}
    </li>`).join('');
  return `<h2 id="modal-title" class="sr-only">Commands</h2>
    <div class="pal-input"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="9" cy="9" r="6"/><path d="m13.5 13.5 4 4"/></svg><input id="paletteinput" value="${esc(m.q)}" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant="pal-${m.active}" aria-label="Type a command or ask Claude" placeholder="Type a command, or ask Claude to change the week"></div>
    <ul class="pal-list" id="pal-list" role="listbox">${list}</ul>
    <div class="pal-foot">${m.q.trim() ? '' : '<span>Try <em>“move Tuesday\'s issues to Dev - Internal”</em></span>'}<span><span class="kbd">↑↓</span> move <span class="kbd">↵</span> run <span class="kbd">esc</span> close</span></div>`;
}
function renderAssist(m) {
  const bubble = (who, text) => `<div class="a-turn ${who}"><span class="a-who">${who === 'you' ? 'You' : `${SPARK} Claude`}</span><div>${esc(text)}</div></div>`;
  const past = m.turns.map(t => bubble('you', t.message) + bubble('claude', t.reply)).join('');
  let now = '';
  if (m.status === 'thinking') now = `<div class="a-turn claude"><span class="a-who">${SPARK} Claude</span><div class="a-wait">Reading your week<span class="dots"><i>.</i><i>.</i><i>.</i></span></div></div>`;
  else if (m.status === 'error') now = `<div class="m-error" role="alert">✗ ${esc(m.reply)}</div>`;
  else {
    now = bubble('claude', m.reply || 'Here is what I would change.');
    if (m.summary.length) now += `<div class="a-changes"><div class="a-label">Changes</div><ul>${m.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ul>${m.remote.length ? `<div class="m-faint">${plural(m.remote.length, 'issue')} ${m.remote.length === 1 ? 'is' : 'are'} already in Linear. You confirm ${m.remote.length === 1 ? 'that delete' : 'those deletes'} next.</div>` : ''}</div>`;
  }
  const canType = m.status !== 'thinking' && m.status !== 'applying';
  return `<div class="m-head"><h2 id="modal-title">${SPARK} Ask Claude</h2><span class="m-faint">Week ${weekNo(state.week)}</span><button class="m-x" data-act="modal-cancel" aria-label="Close" ${m.busy ? 'disabled' : ''}>×</button></div>
    <div class="m-body a-log" data-keep-scroll="assist">${past}${bubble('you', m.message)}${now}</div>
    ${canType ? `<div class="pal-input a-input"><input id="assistinput" autocomplete="off" spellcheck="false" aria-label="Reply to Claude" placeholder="${m.status === 'answer' ? 'Not quite? Say what to change' : 'Ask for something else'}"></div>` : ''}
    <div class="m-foot a-foot">
      <span class="m-faint">${m.status === 'thinking' ? 'This takes about 10 seconds.' : m.status === 'answer' || m.status === 'applying' ? 'Nothing changes until you apply it.' : ''}</span>
      ${m.status === 'thinking' ? '<button class="paper-btn" id="assist-cancel" data-act="modal-cancel">Cancel</button>' : ''}
      ${m.status === 'answer' || m.status === 'applying' ? `<button class="paper-btn" data-act="modal-cancel" ${m.busy ? 'disabled' : ''}>Discard</button><button class="paper-btn solid" id="assist-apply" data-act="assist-apply" ${m.busy ? 'disabled' : ''}>${m.status === 'applying' ? 'Applying…' : 'Apply'}</button>` : ''}
      ${m.status === 'error' ? `<button class="paper-btn" id="assist-retry" data-act="assist-retry">Try again</button>` : ''}
      ${m.status === 'note' ? '<button class="paper-btn" data-act="modal-cancel">Close</button>' : ''}
    </div>`;
}

function renderView() {
  if (state.loadError) { $('#view').innerHTML = `<div class="load-error">✗ ${esc(state.loadError)}</div>`; return; }
  if (!state.draft) return;
  if (state.print) return renderPrint();
  if (state.tab === 'history') return renderHistory();
  if (state.tab === 'settings') return renderSettings();
  renderWeek();
}

// ---------- week ----------
function renderWeek() {
  const feed = !state.fed; state.fed = true;
  $('#view').innerHTML = `<div class="grid ${state.picked.size ? 'picking' : ''}">${renderSetup()}${renderReceipt(feed)}${renderEditor()}</div>${renderBulk()}`;
}

function renderBulk() {
  const its = pickedItems();
  if (!its.length) return '';
  const pushed = its.filter(isFrozen).length;
  const same = f => { const v = new Set(its.map(i => i[f])); return v.size === 1 ? [...v][0] : null; };
  const days = weekDays(state.draft.week);
  return `<div class="bulk" role="toolbar" aria-label="Change the picked issues">
    <span class="bulk-count"><strong>${its.length}</strong> picked</span><span class="bulk-sep" aria-hidden="true"></span>
    <div class="bulk-sel">${select('bulk-project', projectOptions(), same('project'), v => bulkSet('project', v), { placeholder: 'Move to project', label: 'Move picked issues to a project', disabled: pushed > 0 })}</div>
    <div class="bulk-sel">${select('bulk-day', days.map(x => ({ v: x, label: dname(x), hint: state.draft.days.includes(x) ? '' : 'not counted' })), same('day'), v => bulkSet('day', v), { placeholder: 'Move to day', label: 'Move picked issues to a day', disabled: pushed > 0 })}</div>
    <button class="btn" data-act="bulk-merge" ${pushed || its.length < 2 ? 'disabled' : ''}>Merge</button>
    <button class="btn danger" data-act="bulk-delete">Delete</button><span class="bulk-sep" aria-hidden="true"></span>
    <button class="btn ghost" data-act="bulk-clear">Clear <span class="kbd">esc</span></button>
    ${pushed ? `<span class="bulk-note">${pushed} ${pushed === 1 ? 'is' : 'are'} already in Linear, so only Delete works.</span>` : ''}
  </div>`;
}

function renderSetup() {
  const d = state.draft, act = live(), all7 = weekDays(d.week);
  const sessions = new Set(act.flatMap(i => i.evidence.sessions)).size;
  const commits = new Set(act.flatMap(i => i.evidence.commits)).size;
  const projects = new Set(act.map(i => i.project).filter(Boolean)).size;
  const done = d.pushed && !unlogged().length;
  const eh = state.everhour === undefined ? 'Checking Everhour…'
    : state.everhour === null ? "Couldn't read Everhour for this week."
      : `Everhour already has <strong style="color:var(--text);font-weight:600">${fmt(state.everhour)} h</strong> for you this week.`;
  const busy = !!state.busy;
  const effort = d.weightsSource === 'claude' ? 'Effort estimated by Claude.' : d.weightsSource === 'heuristic' ? 'Effort estimated from commits and sessions.' : 'Effort not estimated yet.';
  return `
    <section class="col-setup" aria-label="Week setup">
      <div>
        <h1>${d.pushed ? `Week ${weekNo(d.week)} is printed` : 'Your week, itemised'}</h1>
        <p class="lede">${act.length ? `${plural(act.length, 'issue')} across ${plural(projects, 'project')}, from ${plural(sessions, 'Claude session')} and ${plural(commits, 'commit')}.` : 'Nothing drafted for this week yet.'}</p>
      </div>
      <div class="setup-group">
        <label class="label" for="total" style="margin:0">Hours you worked</label>
        <div class="total-row">
          <input class="total-input" id="total" inputmode="decimal" value="${esc(d.totalHours ?? '')}" placeholder="0" autocomplete="off">
          <button class="btn solid" data-act="itemise" ${busy || !act.length ? 'disabled' : ''}>${state.busy === 'itemise' ? 'Itemising…' : 'Itemise <span class="kbd">D</span>'}</button>
        </div>
        <div class="faint">${effort} <button class="btn link" data-act="reweight" ${busy || !act.length ? 'disabled' : ''}>${state.busy === 'reweight' ? 'Estimating…' : 'Estimate again'}</button></div>
      </div>
      <div class="setup-group">
        <span class="label" style="margin:0">Days that count</span>
        <div class="days">${all7.map(x => `<button class="day-btn ${d.days.includes(x) ? 'on' : ''}" data-act="day" data-d="${esc(x)}" aria-pressed="${d.days.includes(x)}" aria-label="${dname(x)}">${dname(x)[0]}</button>`).join('')}</div>
      </div>
      <div class="setup-group">
        <span class="label" style="margin:0">Before you print</span>
        <div class="checks" aria-live="polite">
          ${blocks().length ? '' : `<div class="check ok"><span class="ico">✓</span><span>${done ? 'Printed. Nothing left to do.' : 'Ready to print.'}</span></div>`}
          ${state.warnings.map(w => {
            const body = `<span class="ico">${w.level === 'block' ? '✕' : '!'}</span><span>${esc(w.message)}</span>`;
            return w.itemId && findItem(w.itemId)
              ? `<button class="check ${esc(w.level)}" data-act="pick" data-id="${esc(w.itemId)}">${body}</button>`
              : `<div class="check ${esc(w.level)}">${body}</div>`;
          }).join('')}
        </div>
        <div class="faint">${eh}</div>
      </div>
      <div class="faint">Press <span class="kbd">/</span> for commands or to ask Claude, <span class="kbd">?</span> for shortcuts.</div>
    </section>`;
}

function renderReceipt(feed) {
  const d = state.draft, act = live(), all7 = weekDays(d.week);
  const sum = act.reduce((s, i) => s + (i.hours ?? 0), 0);
  const per = projectNames().map(n => [n, act.filter(i => i.project === n).reduce((s, i) => s + (i.hours ?? 0), 0)]).filter(([, h]) => h > 0);
  const other = act.filter(i => !projectNames().includes(i.project)).reduce((s, i) => s + (i.hours ?? 0), 0);
  if (other) per.push(['No project', other]);
  const billable = act.filter(i => kindOf(i.project) === 'billable').reduce((s, i) => s + (i.hours ?? 0), 0);
  const parentCount = new Set(act.filter(i => i.project).map(i => `${i.day}|${i.project}`)).size;
  const swatchFor = n => (n === 'No project' ? 'var(--bad-ink)' : color(n));
  const showPrint = !d.pushed || unlogged().length > 0;
  return `
    <section class="col-receipt ${feed ? 'feed' : ''}" aria-label="Receipt">
      <div class="slot"></div>
      <div class="paper-wrap"><div class="paper">
        <div class="paper-head">
          <div style="font-weight:700;font-size:20px">my-timesheet</div>
          <div>Week ${weekNo(d.week)}, ${pretty(all7[0])} to ${pretty(all7[6])}</div>
          <div class="dash"></div>
        </div>
        <div class="paper-scroll" data-keep-scroll="receipt">
          ${act.length ? groupedDays().map(renderDay).join('') : '<div class="empty">No issues yet.<br>Run <strong>/timesheet</strong> in Claude to draft this week, or add an issue by hand.</div>'}
          ${state.adding ? renderAddForm() : '<div class="add-line"><button class="paper-btn" data-act="add">+ Add an issue by hand</button></div>'}
        </div>
        <div class="paper-foot">
          <div class="dash"></div>
          <div class="split-bar" aria-hidden="true">${per.map(([n, h]) => `<span style="width:${sum ? (h / sum) * 100 : 0}%;background:${swatchFor(n)}"></span>`).join('')}</div>
          <div class="legend">${per.map(([n, h]) => `<span><span class="swatch" style="background:${swatchFor(n)}"></span><span class="n">${esc(n)}</span><span class="v">${fmt(h)}</span></span>`).join('')}</div>
          <div class="r-total"><span>Total</span><span>${fmt(sum)} h</span></div>
          <div class="r-sub"><span>You worked ${d.totalHours == null ? '—' : `${fmt(d.totalHours)} h`}</span><span>${sum ? Math.round((billable / sum) * 100) : 0}% billable</span></div>
          <div class="foot-row"><span class="barcode" aria-hidden="true">W${weekNo(d.week)}-${all7[0].slice(0, 4)}</span><span>${plural(act.length, 'sub-issue')}<br>${plural(parentCount, 'parent')}</span></div>
        </div>
        ${d.pushed ? '<div class="stamp">LOGGED</div>' : ''}
      </div></div>
      <div class="tear"></div>
      ${showPrint ? `<button class="btn amber print-btn" data-act="print" ${act.length ? '' : 'disabled'}>Print to Linear and Everhour <span class="kbd">P</span></button>` : ''}
    </section>`;
}

function renderDay(day) {
  const open = !state.collapsed.has(day.day);
  const head = `<button class="r-dayhead" data-act="collapse" data-d="${esc(day.day)}" ${day.counted ? `data-dropday="${esc(day.day)}"` : ''} aria-expanded="${open}"><span><span class="chev">▾</span>${dname(day.day)}${day.counted ? '' : ' (not counted)'}<span class="meta">${plural(day.count, 'issue')}</span></span><span>${fmt(day.total)}</span></button>`;
  const ids = day.groups.flatMap(g => g.items.map(i => i.id));
  const n = ids.filter(id => state.picked.has(id)).length;
  const check = ids.length ? `<button class="r-check ${n && n < ids.length ? 'some' : ''}" data-act="pick-day" data-d="${esc(day.day)}" role="checkbox" aria-checked="${n === 0 ? 'false' : n === ids.length ? 'true' : 'mixed'}" aria-label="Pick every issue on ${dname(day.day)}"></button>` : '';
  const top = `<div class="r-row">${check}${head}</div>`;
  if (!open) return `<div class="r-day">${top}</div>`;
  return `<div class="r-day">${top}${day.groups.map(g => {
    const parent = g.key ? state.draft.parents.find(p => p.key === `${day.day}|${g.key}`) : null;
    const label = g.key ? esc(parentTitle(day.day, g.key)) : 'No project yet';
    return `<div class="r-parent"><span class="swatch" style="background:${g.key ? color(g.key) : 'var(--bad-ink)'}"></span><span>${label}</span>${parent?.linear?.created ? `<span class="pid">${linearLink(parent.linear)}</span>` : ''}</div>
      ${g.items.map(renderLine).join('')}`;
  }).join('')}</div>`;
}

function renderLine(i) {
  const cls = ['r-line', i.id === state.sel ? 'sel' : '', i.project ? '' : 'unassigned', isPushed(i) ? 'pushed' : '', state.mergeFrom === i.id ? 'mark-merge' : ''].filter(Boolean).join(' ');
  const hours = `${isPushed(i) && i.linear.identifier ? `${esc(i.linear.identifier)} ` : ''}${i.locked ? '* ' : ''}${fmt(i.hours)}`;
  const picked = state.picked.has(i.id);
  return `<div class="r-row ${picked ? 'picked' : ''}"><button class="r-check" data-act="pick-toggle" data-id="${esc(i.id)}" role="checkbox" aria-checked="${picked}" aria-label="Pick ${esc(i.title)}"></button><button class="${cls}" data-act="pick" data-id="${esc(i.id)}" aria-pressed="${i.id === state.sel}" draggable="${!isFrozen(i)}">
    <span class="t">${esc(i.title)}</span><span class="lead"></span><span class="h ${state.flash.has(i.id) ? 'flash' : ''}">${hours}</span></button></div>`;
}

function renderAddForm() {
  const days = state.draft.days.length ? [...state.draft.days].sort() : weekDays(state.week);
  const dayNow = state.addDay ?? (days.includes(findItem(state.sel)?.day) ? findItem(state.sel).day : days[0]);
  return `<form class="add-form" id="addform">
    <input id="add-title" placeholder="Title, 2 to 3 words" required aria-label="Title" autocomplete="off">
    <input id="add-desc" placeholder="What you did" aria-label="What you did" autocomplete="off">
    <div class="two">
      <div>${select('add-project', projectOptions(), state.addProject ?? projectNames()[0], v => { state.addProject = v; }, { paper: true, label: 'Project' })}</div>
      <div>${select('add-day', days.map(x => ({ v: x, label: dname(x) })), dayNow, v => { state.addDay = v; }, { paper: true, label: 'Day' })}</div>
    </div>
    <div class="two"><button class="paper-btn solid" type="submit">Add issue</button><button class="paper-btn" type="button" data-act="cancel-add">Cancel</button></div>
  </form>`;
}

function renderEditor() {
  const it = findItem(state.sel);
  if (!it) return '<section class="col-editor" aria-label="Issue editor"><div class="ed-empty"><h2>No issue selected</h2><p class="muted" style="margin:0">Pick an issue on the receipt, or add one by hand.</p></div></section>';
  const ro = isPushed(it), frozen = isFrozen(it);
  const others = live().filter(i => i.id !== it.id && !isFrozen(i));
  const days = weekDays(state.draft.week);
  const ev = it.evidence;
  const f = `data-for="${esc(it.id)}"`;
  const source = ev.manual ? '<span class="chip">Added by hand</span>' : `<span class="chip">${plural(ev.commits.length, 'commit')}</span><span class="chip">${plural(ev.sessions.length, 'Claude session')}</span>`;
  return `
    <section class="col-editor" aria-label="Issue editor" data-keep-scroll="editor">
      <div class="ed-head"><span class="faint">${dname(it.day)}${it.project ? ` in ${esc(it.project)}` : ''}</span>${ro ? `<span class="chip">In Linear as <span class="linear-id">${linearLink(it.linear)}</span></span>` : (it.locked ? '<span class="chip">Hours locked</span>' : '')}</div>
      <div class="ed-field">
        <label class="sr-only" for="ed-title">Title</label>
        <input class="ed-input" id="ed-title" ${f} value="${esc(it.title)}" autocomplete="off" ${ro ? 'disabled' : ''} ${ro ? 'aria-describedby="ed-title-hint"' : 'placeholder="Two or three words"'}>
        ${ro ? `<span class="faint" id="ed-title-hint" style="margin-top:8px">Already in Linear${it.everhour?.logged ? ' and Everhour' : ''}, so only delete works on it.</span>` : ''}
      </div>
      <div class="ed-field"><label class="label" for="ed-desc">What you did</label><textarea class="ed-text" id="ed-desc" ${f} ${ro ? 'disabled' : ''}>${esc(it.description)}</textarea></div>
      <div class="ed-field">
        <div class="two-col">
          <div><span class="label">Project</span>${select('ed-project', projectOptions(), it.project, v => setField(it, 'project', v), { disabled: ro, placeholder: 'Pick a project', label: 'Project' })}</div>
          <div><span class="label">Day</span>${select('ed-day', days.map(x => ({ v: x, label: dname(x), hint: state.draft.days.includes(x) ? '' : 'not counted' })), it.day, v => setField(it, 'day', v), { disabled: ro, label: 'Day' })}</div>
        </div>
        <span class="faint" style="margin-top:8px">${it.project ? `Why ${esc(it.project)}` : 'Why unsure'}: ${esc(it.bucketReason || 'no reason given')}</span>
      </div>
      <div class="ed-field">
        <span class="label">Hours</span>
        <div class="stepper">
          <button class="icon-btn" data-act="less" aria-label="Half an hour less" ${frozen ? 'disabled' : ''}>−</button>
          <span class="val ${state.flash.has(it.id) ? 'flash' : ''}">${fmt(it.hours)}</span>
          <button class="icon-btn" data-act="more" aria-label="Half an hour more" ${frozen ? 'disabled' : ''}>+</button>
          <button class="btn ghost" data-act="lock" aria-pressed="${it.locked}" ${ro ? 'disabled' : ''}>${it.locked ? 'Unlock' : 'Lock'}</button>
        </div>
        <span class="faint" style="margin-top:8px">${it.locked ? 'Locked. Itemise leaves these hours alone.' : 'Changing hours locks them and rebalances the rest.'}</span>
      </div>
      <div class="ed-field">
        <span class="label">Where it came from</span>
        <div class="chips">${source}${it.edited && !ev.manual ? '<span class="chip">Edited by you</span>' : ''}</div>
        <span class="faint" style="margin-top:8px">${it.weight != null ? `Effort ${Math.round(it.weight * 10) / 10} of 10${it.weightReason ? `: ${esc(it.weightReason)}` : ''}.` : 'Effort not estimated yet.'}</span>
      </div>
      <div class="divider"></div>
      ${frozen ? `<div class="actions"><button class="btn danger" data-act="delete-pushed">Delete issue</button><span class="faint">Moves it to Linear's trash and clears its Everhour time. You confirm first.</span></div>` : `<div class="actions">
        <div class="wide">${select('ed-merge', others.map(o => ({ v: o.id, label: o.title, hint: dname(o.day).slice(0, 3), color: o.project ? color(o.project) : 'var(--bad-ink)' })), null, v => mergeInto(it.id, v), { placeholder: 'Merge another issue into this one', label: 'Merge another issue into this one', disabled: !others.length })}</div>
        <button class="btn" data-act="split">Split in two <span class="kbd">s</span></button>
        <span class="spacer"></span>
        <button class="btn danger ${state.armedDelete === it.id ? 'armed' : ''}" data-act="delete">${state.armedDelete === it.id ? 'Press again to delete' : 'Delete issue'}</button>
      </div>`}
    </section>`;
}

// ---------- print ----------
const PHASES = ['parents', 'issues', 'sync', 'time'];

function newPrint(draft, stage) {
  const pending = draft.items.filter(i => !i.deleted && !i.everhour?.logged);
  return {
    week: draft.week, stage, ehHours: null, lastPhase: 'parents', seen: new Map(),
    ids: pending.map(i => i.id),
    parents: new Set(pending.filter(i => i.project).map(i => `${i.day}|${i.project}`)).size,
    hours: pending.reduce((s, i) => s + (i.hours ?? 0), 0),
    projects: [...new Set(pending.map(i => i.project).filter(Boolean))],
  };
}

/** P, the Print button, the palette's print. Continuing after awaiting_sync needs no extra confirm. */
function requestPush() {
  if (!state.draft || !live().length) return;
  if (state.push?.status === 'awaiting_sync') {
    if (!state.print) state.print = newPrint(state.draft, 'server');
    render();
    return startPush(true);
  }
  if (state.push?.status === 'running') { state.print ??= newPrint(state.draft, 'server'); render(); return pollPush(); }
  state.print = newPrint(state.draft, blocks().length ? 'blocked' : 'confirm');
  state.help = false;
  render();
}

let starting = false;
async function startPush(confirm) {
  if (starting) return; // a second click or key press while the first start is on its way
  starting = true;
  state.print ??= newPrint(state.draft, 'server');
  state.print.starting = true; render();
  try {
    if (!(await save())) return toast(`Your edits aren't saved (${state.saveError ?? 'unknown error'}), so printing didn't start.`);
    // Push the week the prompt named, never whatever week is on screen now.
    const week = state.print?.week;
    if (!week || week !== state.week) {
      state.print = null;
      return toast(`You switched weeks, so nothing was printed. Open week ${week ? weekNo(week) : ''} and press Print again.`);
    }
    try {
      await api('POST', '/api/push', { week, confirm });
    } catch (e) {
      if (e.status === 409 && e.body?.needsConfirm && state.print) { state.print.stage = 'everhour'; state.print.ehHours = e.body.hours; return; }
      return toast(e.message); // 423 and the rest: just say why
    }
    if (!state.print) return;
    state.print.stage = 'server';
    state.push = { status: 'running', phase: 'parents', done: 0, total: 0 };
    pollPush();
  } finally {
    starting = false;
    if (state.print) state.print.starting = false;
    render();
  }
}

/** GET /api/push, retried with backoff (0.4, 0.8, 1.6, 3.2 s) before giving up. */
async function fetchPush(week) {
  for (let attempt = 0; ; attempt++) {
    try { return await api('GET', `/api/push?week=${week}`); } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(400 * 2 ** attempt);
    }
  }
}

let polling = false, refreshing = false;
async function pollPush() {
  if (polling) return;
  polling = true;
  const week = state.week;
  try {
    for (;;) {
      let p;
      try { p = await fetchPush(week); } catch (e) {
        // lost the server: stop showing "running" so the screen can be closed
        if (state.week === week) { state.push = { status: 'error', error: `Lost contact with the review server: ${e.message}` }; render(); }
        return;
      }
      if (state.week !== week) return;
      const prev = state.push;
      state.push = p;
      if (p.phase && state.print) state.print.lastPhase = p.phase;
      if (p.status !== 'running') { await load(week); return; }
      if (p.phase !== prev?.phase || p.done !== prev?.done) refreshDraft(week); // identifiers and logged hours appear as they land
      render();
      await sleep(400);
    }
  } catch (e) {
    toast(e.message);
  } finally { polling = false; }
}

async function refreshDraft(week) {
  if (refreshing || state.saving || hasPending()) return;
  refreshing = true;
  try {
    const s = await api('GET', `/api/state?week=${week}`);
    if (state.week === week && !hasPending()) accept(s);
  } catch { /* the next poll tries again */ } finally { refreshing = false; }
}

function renderPrint() {
  const pr = state.print, p = state.push ?? { status: 'idle' };
  const n = weekNo(pr.week);
  const status = pr.stage === 'server' ? (p.status === 'idle' ? 'running' : p.status) : pr.stage;
  const phase = status === 'awaiting_sync' ? 'sync' : status === 'running' ? (p.phase ?? 'parents') : pr.lastPhase;
  const at = PHASES.indexOf(phase);
  const stepState = k => (status === 'done' || PHASES.indexOf(k) < at ? 'done' : PHASES.indexOf(k) === at ? 'now' : '');
  const totalFor = k => (k === 'parents' ? pr.parents : pr.ids.length);
  const count = k => {
    const s = stepState(k);
    if (s === 'done') return k === 'time' ? `${fmt(pr.hours)} h` : `${totalFor(k)} of ${totalFor(k)}`;
    if (s === 'now' && status === 'running') return `${p.done ?? 0} of ${p.total || totalFor(k)}`;
    return '';
  };
  const meter = k => (stepState(k) === 'now' && status === 'running' ? `<div class="meter"><span style="width:${Math.round(((p.done ?? 0) / Math.max(1, p.total || totalFor(k))) * 100)}%"></span></div>` : '');
  const step = (k, num, title, note) => `<li class="step"><span class="mark ${stepState(k)}">${stepState(k) === 'done' ? '✓' : num}</span><div><div class="step-head"><span>${title}</span><span class="step-count">${count(k)}</span></div><div class="muted" style="font-size:14px">${note}</div>${meter(k)}</div></li>`;
  const syncProjects = status === 'awaiting_sync' ? [...new Set((p.missing ?? []).map(m => m.project))] : [];
  const projTag = name => `<span class="proj-tag"><span class="swatch" style="background:${color(name)}"></span>${esc(name)}</span>`;

  let panel = '';
  if (status === 'blocked') {
    const list = pr.stage === 'blocked' ? blocks().map(w => w.message) : (p.warnings ?? []).map(w => w.message);
    panel = `<div class="callout bad"><strong>Fix these before printing</strong>${list.map(m => `<div>✗ ${esc(m)}</div>`).join('')}<div><button class="btn" data-act="print-cancel">Back to the week</button></div></div>`;
  } else if (status === 'confirm' || status === 'everhour') {
    const q = status === 'confirm' ? `Print week ${n}?`
      : pr.ehHours == null ? `Couldn't read Everhour for week ${n}. Print anyway?`
        : `Everhour already has ${fmt(pr.ehHours)} h for you in week ${n}. Print anyway?`;
    panel = `<div class="callout"><strong style="font-size:17px">${q}</strong><div>Creates ${plural(pr.parents, 'parent issue')} and ${plural(pr.ids.length, 'sub-issue')} in Linear across ${plural(pr.projects.length, 'project')}, assigned to you and set to Done, then logs ${fmt(pr.hours)} h in Everhour.</div><div class="row"><button class="btn ink" data-act="${status === 'confirm' ? 'print-go' : 'print-anyway'}" ${pr.starting ? 'disabled' : ''}>${status === 'confirm' ? 'Print' : 'Print anyway'} <span class="kbd">y</span></button><button class="btn" data-act="print-cancel">Not now <span class="kbd">n</span></button></div></div>`;
  } else if (status === 'awaiting_sync') {
    panel = `<div class="callout"><strong style="font-size:17px">One click in Everhour</strong><div>Everhour can't pull new Linear issues by itself. Open Everhour, go to Projects, and press Sync on each of these:</div><div class="row">${syncProjects.map(projTag).join('')}</div><div class="row"><button class="btn ink" data-act="synced" ${pr.starting ? 'disabled' : ''}>I pressed Sync, log the hours</button><a class="btn" style="text-decoration:none" href="https://app.everhour.com/" target="_blank" rel="noopener">Open Everhour</a><button class="btn" data-act="print-cancel">Later</button></div></div>`;
  } else if (status === 'error') {
    panel = `<div class="callout bad"><strong>Printing stopped</strong><div>${esc(p.error ?? 'Something went wrong.')}</div><div class="row"><button class="btn" data-act="print-retry" ${pr.starting ? 'disabled' : ''}>Try again</button><button class="btn" data-act="print-cancel">Back to the week</button></div></div>`;
  } else if (status === 'done') {
    panel = '<div><button class="btn solid" data-act="print-close">Back to the week</button></div>';
  }

  const headline = { blocked: `Week ${n} can't print yet`, confirm: `Print week ${n}`, everhour: `Print week ${n}`, running: `Printing week ${n}`, awaiting_sync: `Printing week ${n}`, error: `Printing week ${n}`, done: `Week ${n} is printed` }[status];
  const sub = {
    blocked: 'Nothing was sent.',
    confirm: 'Check the receipt one more time.',
    everhour: 'Check the receipt one more time.',
    running: phase === 'time' ? 'Logging hours in Everhour.' : 'Creating issues in Linear. Safe to run again if it stops.',
    awaiting_sync: 'Linear has every issue. Everhour needs one click from you before the hours can go in.',
    error: 'Everything done so far is saved. Printing again picks up where it stopped.',
    done: `${plural(pr.ids.length, 'sub-issue')} under ${plural(pr.parents, 'parent')} are in Linear, and ${fmt(pr.hours)} h are in Everhour. Printing again changes nothing.`,
  }[status];
  const showSteps = status !== 'blocked' && status !== 'confirm' && status !== 'everhour';

  const rows = pr.ids.map(id => state.draft.items.find(i => i.id === id)).filter(Boolean);
  const logged = rows.filter(i => i.everhour?.logged).reduce((s, i) => s + (i.hours ?? 0), 0);
  const firstPaint = pr.seen.size === 0;
  const rowHtml = rows.map(i => {
    const ident = i.linear?.identifier ?? '';
    const on = !!i.everhour?.logged;
    const key = `${ident}|${on}`;
    const appear = !firstPaint && pr.seen.get(i.id) !== key;
    pr.seen.set(i.id, key);
    return `<div class="p-row ${appear ? 'appear' : ''}"><span class="swatch" style="background:${color(i.project)}"></span><span class="w">${ident ? linearLink(i.linear) : '·······'}</span><span class="t">${esc(i.title)}</span><span class="h ${on ? 'on' : 'wait'}">${on ? fmt(i.hours) : 'waiting'}</span></div>`;
  }).join('');

  $('#view').innerHTML = `
    <div class="print">
      <section class="print-main">
        <div><h1>${headline}</h1><p class="lede">${sub}</p></div>
        ${showSteps ? `<ol class="steps">
          ${step('parents', 1, 'Parent issues in Linear', 'One per day and project, assigned to you, set to Done.')}
          ${step('issues', 2, 'Sub-issues in Linear', 'Each under its day. No hours in any title or description.')}
          ${step('sync', 3, 'Sync in Everhour', status === 'awaiting_sync' ? `${plural((p.missing ?? []).length, 'issue')} aren't in Everhour yet.` : 'Everhour finds every sub-issue.')}
          ${step('time', 4, 'Hours on each sub-issue', 'Logged on the day each issue belongs to.')}
        </ol>` : ''}
        ${panel}
      </section>
      <section class="col-receipt" aria-label="Print receipt">
        <div class="slot"></div>
        <div class="paper-wrap"><div class="paper">
          <div class="paper-head"><div style="font-weight:700;font-size:19px">Linear and Everhour</div><div>Week ${n}</div><div class="dash"></div></div>
          <div class="paper-scroll" data-keep-scroll="print">${rowHtml || '<div class="empty">Nothing left to print.</div>'}</div>
          <div class="paper-foot"><div class="dash"></div><div class="r-total" style="font-size:22px"><span>Logged</span><span>${fmt(logged)} h</span></div><div class="barcode" aria-hidden="true">W${n}</div></div>
          ${status === 'done' ? '<div class="stamp">LOGGED</div>' : ''}
        </div></div>
        <div class="tear"></div>
      </section>
    </div>`;
}

function closePrint() {
  if (state.push?.status === 'running') return toast('Printing is still running.');
  state.print = null; state.fed = false; render();
}

// ---------- history ----------
async function openHistory() {
  state.tab = 'history'; state.print = null; render();
  try { state.history = await api('GET', '/api/history'); } catch (e) { toast(e.message); state.history ??= []; }
  if (state.tab === 'history') render();
}

function renderHistory() {
  if (!state.history) { $('#view').innerHTML = '<div class="page"><div><h1>Past weeks</h1><p class="lede">Loading…</p></div></div>'; return; }
  const weeks = [...state.history].sort((a, b) => a.week.localeCompare(b.week));
  const max = Math.max(1, ...weeks.map(w => w.total));
  const printed = weeks.filter(w => w.pushed);
  const avg = printed.length ? printed.reduce((s, w) => s + w.total, 0) / printed.length : 0;
  const used = new Set(weeks.flatMap(w => Object.keys(w.byProject ?? {})));
  $('#view').innerHTML = `
    <div class="page">
      <div class="page-head">
        <div><h1>Past weeks</h1><p class="lede">Every week you've drafted. Taller receipts are longer weeks.</p></div>
        <div><div style="font-family:var(--mono);font-weight:700;font-size:30px">${fmt(avg)} h</div><div class="faint">average over ${plural(printed.length, 'printed week')}</div></div>
      </div>
      <div class="hist">
        ${weeks.length ? weeks.map((w, k) => {
          const days = weekDays(w.week);
          const parts = Object.entries(w.byProject ?? {}).filter(([, h]) => h > 0).sort(([a], [b]) => projectNames().indexOf(a) - projectNames().indexOf(b));
          return `<button class="hist-card ${w.pushed ? '' : 'draft'}" data-act="open-week" data-w="${esc(w.week)}" style="height:${Math.round(150 + (w.total / max) * 280)}px;animation-delay:${k * 70}ms" aria-label="Week ${weekNo(w.week)}, ${fmt(w.total)} hours, ${w.pushed ? 'printed' : 'draft'}">
            <span style="font-weight:700;font-size:17px">Week ${weekNo(w.week)}</span>
            <span style="font-size:13px;color:var(--ink-2)">${pretty(days[0])} to ${pretty(days[6])}</span>
            <span style="flex:1"></span>
            ${parts.length ? `<span class="stack-bar">${parts.map(([pn, h]) => `<span title="${esc(pn)}" style="width:${w.total ? (h / w.total) * 100 : 0}%;background:${color(pn)}"></span>`).join('')}</span>` : ''}
            <span class="big">${fmt(w.total)} h</span>
            <span style="font-size:13px">${plural(w.items, 'issue')}, ${w.pushed ? 'printed' : 'draft'}</span>
          </button>`;
        }).join('') : '<p class="hist-empty">No weeks drafted yet. Run /timesheet in Claude to draft one.</p>'}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:16px">${projectNames().filter(pn => used.has(pn)).map(pn => `<span class="faint" style="display:inline-flex;align-items:center;gap:6px"><span class="swatch" style="background:${color(pn)}"></span>${esc(pn)}</span>`).join('')}</div>
    </div>`;
}

// ---------- settings ----------
async function openSettings() {
  state.tab = 'settings'; state.print = null; render();
  try { state.settings = await api('GET', '/api/settings'); } catch (e) { toast(e.message); }
  if (state.tab === 'settings') render();
}

async function saveSettings() {
  const s = state.settings;
  state.settingsSaving = true; renderTop();
  try {
    await api('PUT', '/api/settings', {
      projects: s.projects.map(({ name, kind }) => ({ name, kind })),
      repos: s.repos.map(r => ({ root: r.root, class: r.class, project: r.class === 'work' ? r.project || undefined : undefined })),
      workOrgs: s.workOrgs,
      nudge: s.nudge,
    });
    for (const p of state.projects) p.kind = s.projects.find(x => x.name === p.name)?.kind ?? p.kind;
  } catch (e) {
    toast(e.message);
    try { state.settings = await api('GET', '/api/settings'); } catch { /* keep what we have */ }
    if (state.tab === 'settings') render();
  } finally { state.settingsSaving = false; renderTop(); }
}

/** First press arms the button, the second removes the project from the config (Linear and Everhour are untouched). */
async function removeProject(name) {
  if (!name) return;
  if (state.armedRemove !== name) { state.armedRemove = name; render(); return; }
  state.armedRemove = null;
  state.settingsSaving = true; renderTop();
  try {
    state.settings = await api('POST', '/api/projects/remove', { name });
    state.projects = state.projects.filter(p => p.name !== name);
    toast(`Removed ${name}`);
  } catch (e) {
    toast(e.message);
  } finally { state.settingsSaving = false; render(); }
}

function renderSettings() {
  const s = state.settings;
  if (!s) { $('#view').innerHTML = '<div class="page"><div><h1>Settings</h1><p class="lede">Loading…</p></div></div>'; return; }
  const billable = s.projects.filter(p => p.kind === 'billable');
  const repoOptions = r => {
    const opts = [{ v: '', label: 'Ask me each time' }, ...billable.map(p => ({ v: p.name, label: `Bills to ${p.name}`, color: color(p.name) }))];
    if (r.project && !opts.some(o => o.v === r.project)) opts.push({ v: r.project, label: `Bills to ${r.project}`, color: color(r.project) });
    return opts;
  };
  $('#view').innerHTML = `
    <div class="page">
    <div><h1>Settings</h1><p class="lede">What counts as work, where it bills, and when to remind you.</p></div>
    <div class="settings">
      <section class="slip" aria-label="Repos">
        <h2>Repos</h2>
        <p>Only work repos are logged. Repos in your work orgs count as work automatically; anything else is asked about once.</p>
        ${s.repos.length ? s.repos.map((r, k) => `<div class="slip-row">
          <div class="slip-row inline flat">
            <span class="repo-name" title="${esc(r.root)}">${r.class === 'work' && r.project ? `<span class="swatch" style="background:${color(r.project)}"></span>` : ''}<span>${esc(r.name ?? r.root)}</span></span>
            <div class="seg">${['work', 'personal', 'ignore'].map(c => `<button class="${r.class === c ? 'on' : ''}" data-act="repo-cls" data-k="${k}" data-c="${c}" aria-pressed="${r.class === c}">${c[0].toUpperCase() + c.slice(1)}</button>`).join('')}</div>
          </div>
          ${r.class === 'work' ? select(`repo-${k}`, repoOptions(r), r.project ?? '', v => { r.project = v || undefined; saveSettings(); }, { label: `Project for ${r.name ?? r.root}` }) : ''}
        </div>`).join('') : '<p>No repos seen yet. They show up after your first Claude session in one.</p>'}
      </section>
      <div class="settings-col">
        <section class="slip" aria-label="Projects">
          <h2>Projects</h2>
          ${s.projects.map((p, k) => `<div class="slip-row inline"><span class="repo-name"><span class="swatch" style="background:${color(p.name)}"></span><span>${esc(p.name)}</span></span><div class="proj-actions"><div class="seg">${['billable', 'internal'].map(c => `<button class="${p.kind === c ? 'on' : ''}" data-act="proj-kind" data-k="${k}" data-c="${c}" aria-pressed="${p.kind === c}">${c[0].toUpperCase() + c.slice(1)}</button>`).join('')}</div><button class="proj-remove ${state.armedRemove === p.name ? 'armed' : ''}" data-act="proj-remove" data-k="${k}" aria-label="Remove ${esc(p.name)}">${state.armedRemove === p.name ? 'Press again' : 'Remove'}</button></div></div>`).join('')}
          <p>Removing a project only takes it off this list. Nothing changes in Linear or Everhour. To add a project, run <strong>timesheet init</strong> in a terminal.</p>
        </section>
        <section class="slip" aria-label="Work orgs">
          <h2>Work orgs on GitHub</h2>
          <label for="orgs">Comma-separated<input type="text" id="orgs" value="${esc(s.workOrgs.join(', '))}" autocomplete="off"></label>
        </section>
        <section class="slip" aria-label="Sunday reminder">
          <h2>Sunday reminder</h2>
          <div class="slip-row inline flat"><p>Claude mentions it once on Sunday evening or Monday if the week isn't printed.</p><div class="seg"><button class="${s.nudge ? 'on' : ''}" data-act="nudge" data-v="1" aria-pressed="${s.nudge}">On</button><button class="${!s.nudge ? 'on' : ''}" data-act="nudge" data-v="0" aria-pressed="${!s.nudge}">Off</button></div></div>
        </section>
        <p class="faint" style="margin:0">Your Linear and Everhour keys live in the macOS Keychain. To change them, run timesheet init in a terminal.</p>
      </div>
    </div>
    </div>`;
}

// ---------- navigation and commands ----------
function goWeek(week) {
  state.tab = 'week'; state.print = null; state.fed = false;
  return load(week).catch(e => toast(e.message));
}
function switchTab(tab) {
  state.openSel = null;
  if (tab === 'history') return openHistory();
  if (tab === 'settings') return openSettings();
  state.tab = 'week'; state.print = null; state.fed = false; render();
}
// ---------- events ----------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (state.openSel && (!t || (t.dataset.act !== 'sel-toggle' && t.dataset.act !== 'sel-pick'))) { state.openSel = null; if (!t) { render(); return; } }
  if (!t || t.disabled) return;
  const a = t.dataset.act;
  const it = findItem(state.sel);
  if (a !== 'delete') state.armedDelete = null;
  if (a !== 'proj-remove' && state.armedRemove) { state.armedRemove = null; if (state.tab === 'settings') render(); }
  switch (a) {
    case 'sel-toggle': state.openSel = state.openSel === t.dataset.sel ? null : t.dataset.sel; state.selActive = 0; render(); break;
    case 'sel-pick': pickSel(t.dataset.sel, +t.dataset.k); break;
    case 'tab': switchTab(t.dataset.k); break;
    case 'prev': case 'next': goWeek(shiftWeek(state.week, a === 'prev' ? -1 : 1)); break;
    case 'open-week': goWeek(t.dataset.w); break;
    case 'collapse': { const d = t.dataset.d; if (state.collapsed.has(d)) state.collapsed.delete(d); else state.collapsed.add(d); render(); break; }
    case 'pick-toggle': togglePick(t.dataset.id, e.shiftKey); break;
    case 'pick-day': pickDay(t.dataset.d); break;
    case 'bulk-merge': bulkMerge(); break;
    case 'bulk-delete': { const its = pickedItems(); if (its.length === 1 && !isFrozen(its[0])) { act('/api/delete', { id: its[0].id }).then(d => d && toast("Issue deleted. /timesheet won't redraft it.")); } else requestDelete(its.map(i => i.id)); break; }
    case 'bulk-clear': clearPicked(); break;
    case 'delete-pushed': if (it) requestDelete([it.id]); break;
    case 'modal-back': case 'modal-cancel': closeModal(); break;
    case 'modal-ok': runConfirm(); break;
    case 'pal-run': runPaletteRow(+t.dataset.k); break;
    case 'assist-apply': applyAssist(); break;
    case 'assist-retry': { const m = state.modal; if (m?.kind === 'assist') askClaude(m.message, m.turns); break; }
    case 'pick': {
      const id = t.dataset.id;
      if (e.shiftKey || e.metaKey || e.ctrlKey) { togglePick(id, e.shiftKey); break; }
      if (state.mergeFrom && state.mergeFrom !== id && t.classList.contains('r-line')) { const target = findItem(id); if (target && !isFrozen(target)) { mergeInto(state.mergeFrom, id); break; } }
      selectLine(id);
      break;
    }
    case 'itemise': distribute(false); break;
    case 'reweight': distribute(true); break;
    case 'day': { const d = t.dataset.d, days = state.draft.days; state.draft.days = days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort(); scheduleSave(); render(); break; }
    case 'less': stepHours(it, -0.5, 1); break;
    case 'more': stepHours(it, 0.5, 0); break;
    case 'lock': if (it) setField(it, 'locked', !it.locked); break;
    case 'split': splitLine(it); break;
    case 'delete': deleteLine(it); break;
    case 'add': openAdd(); break;
    case 'cancel-add': state.adding = false; render(); break;
    case 'print': requestPush(); break;
    case 'print-go': startPush(false); break;
    case 'print-anyway': case 'synced': startPush(true); break;
    case 'print-retry': startPush(false); break;
    case 'print-cancel': case 'print-close': closePrint(); break;
    case 'repo-cls': { const r = state.settings.repos[+t.dataset.k]; r.class = t.dataset.c; if (r.class !== 'work') r.project = undefined; render(); saveSettings(); break; }
    case 'proj-kind': state.settings.projects[+t.dataset.k].kind = t.dataset.c; render(); saveSettings(); break;
    case 'proj-remove': removeProject(state.settings.projects[+t.dataset.k]?.name); break;
    case 'nudge': state.settings.nudge = t.dataset.v === '1'; render(); saveSettings(); break;
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  const it = findItem(state.sel);
  if (t.id === 'total') {
    const v = t.value.trim() === '' ? null : Number(t.value);
    if (v !== null && !(v > 0)) { toast('Hours must be a number above 0.'); t.value = state.draft.totalHours ?? ''; return; }
    state.draft.totalHours = v; scheduleSave(); // no re-render, so a click on Itemise right after typing still lands
  } else if ((t.id === 'ed-title' || t.id === 'ed-desc') && it && t.dataset.for === it.id) {
    const field = t.id === 'ed-title' ? 'title' : 'description';
    if (!t.value.trim()) { t.value = it[field]; return toast(`The ${field} can't be empty, so it was kept.`); }
    setField(it, field, t.value.trim(), false);
  } else if (t.id === 'orgs' && state.settings) { state.settings.workOrgs = t.value.split(',').map(x => x.trim()).filter(Boolean); saveSettings(); }
});

document.addEventListener('submit', e => {
  if (e.target.id !== 'addform') return;
  e.preventDefault();
  submitAdd();
});

/** Keys while a modal is open: Esc closes, Tab stays inside, the palette moves with arrows and runs on Enter. */
function modalKey(e) {
  const m = state.modal;
  if (e.key === 'Escape') { e.preventDefault(); return closeModal(); }
  if (e.key === 'Tab') {
    const f = [...document.querySelectorAll('.modal button:not([disabled]), .modal input')];
    if (!f.length) return;
    const k = f.indexOf(document.activeElement);
    e.preventDefault();
    f[(k + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    return;
  }
  if (m.kind === 'palette' && e.target.id === 'paletteinput') {
    const n = paletteRows(m.q).length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); m.active = (m.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % Math.max(1, n); renderOverlay(); $('#paletteinput')?.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPaletteRow(m.active); }
    return;
  }
  if (m.kind === 'assist' && e.target.id === 'assistinput' && e.key === 'Enter') { e.preventDefault(); followUp(e.target.value); }
}

document.addEventListener('input', e => {
  if (e.target.id !== 'paletteinput' || state.modal?.kind !== 'palette') return;
  state.modal.q = e.target.value; state.modal.active = 0;
  render();
});

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return state.modal?.kind === 'palette' ? closeModal() : openPalette(); }
  if (state.modal) return modalKey(e);
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target.tagName;
  if (state.openSel) {
    const s = SELS[state.openSel];
    if (!s) { state.openSel = null; return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); state.selActive = (state.selActive + (e.key === 'ArrowDown' ? 1 : -1) + s.options.length) % Math.max(1, s.options.length); render(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickSel(state.openSel, state.selActive); }
    else if (e.key === 'Escape' || e.key === 'Tab') { const id = state.openSel; state.openSel = null; render(); document.getElementById(id)?.focus(); }
    return;
  }
  if (TEXT_TAGS.includes(tag)) {
    if (e.key === 'Escape') { if (e.target.closest('#addform')) { state.adding = false; render(); } else e.target.blur(); }
    if (e.key === 'Enter' && tag === 'INPUT' && e.target.closest('.col-editor, .col-setup')) e.target.blur();
    return;
  }
  if (e.target.classList?.contains('sel-btn') && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); state.openSel = e.target.id; state.selActive = 0; render(); return; }
  const k = e.key;
  if (state.print && (state.print.stage === 'confirm' || state.print.stage === 'everhour')) {
    if (k === 'y') { e.preventDefault(); return startPush(state.print.stage === 'everhour'); }
    if (k === 'n' || k === 'Escape') { e.preventDefault(); toast('Not printed.'); return closePrint(); }
  }
  if (k === '?') { state.help = !state.help; return renderOverlay(); }
  if (k === '/') { e.preventDefault(); return openPalette(); }
  if (k === 'Escape') {
    if (state.help) { state.help = false; return renderOverlay(); }
    if (state.picked.size && !state.print) return clearPicked();
    state.mergeFrom = null; state.armedDelete = null; if (state.print) return closePrint(); return render();
  }
  if (state.tab !== 'week' || state.print || !state.draft) return;
  const lines = visibleLines();
  const it = findItem(state.sel);
  const editable = it && !isFrozen(it);
  if (k === 'j' || k === 'k') {
    const idx = lines.findIndex(i => i.id === state.sel);
    const next = lines[Math.max(0, Math.min(lines.length - 1, idx + (k === 'j' ? 1 : -1)))];
    if (next) selectLine(next.id);
  }
  else if (k === 'e' && editable) { e.preventDefault(); $('#ed-title')?.focus(); $('#ed-title')?.select(); }
  else if (k === 'p' && editable) { const names = projectNames(); if (names.length) setField(it, 'project', names[(names.indexOf(it.project) + 1) % names.length]); }
  else if ((k === '[' || k === ']') && editable) stepHours(it, k === ']' ? 0.5 : -0.5, 0.5);
  else if (k === 'L' && editable) setField(it, 'locked', !it.locked);
  else if (k === 's' && editable) splitLine(it);
  else if (k === 'm' && editable) toggleMark(it);
  else if (k === 'd' && editable) deleteLine(it);
  else if (k === 'd' && it) requestDelete([it.id]);
  else if (k === 'x' && it) togglePick(it.id);
  else if (k === 'a') { e.preventDefault(); openAdd(); }
  else if (k === 'D') distribute(false);
  else if (k === 'P') requestPush();
});

// drag an issue onto a counted day's heading to move it there
document.addEventListener('dragstart', e => { const r = e.target.closest?.('.r-line'); if (r) e.dataTransfer.setData('text/plain', r.dataset.id); });
document.addEventListener('dragover', e => { const h = e.target.closest?.('[data-dropday]'); if (h) { e.preventDefault(); h.classList.add('drop'); } });
document.addEventListener('dragleave', e => { e.target.closest?.('[data-dropday]')?.classList.remove('drop'); });
document.addEventListener('drop', e => {
  const target = e.target.closest?.('[data-dropday]');
  if (!target) return;
  e.preventDefault();
  const it = findItem(e.dataTransfer.getData('text/plain'));
  if (it && !isFrozen(it)) setField(it, 'day', target.dataset.dropday);
  else render();
});

/** True while the person is typing somewhere a reload would wipe. */
function isEditing() {
  const ae = document.activeElement;
  return state.adding || !!state.openSel || !!state.modal || (!!ae && TEXT_TAGS.includes(ae.tagName));
}

setInterval(async () => {
  if (!state.draft || state.saving) return;
  try {
    const { rev } = await api('GET', `/api/rev?week=${state.week}`);
    if (rev > state.base.rev && !hasPending() && !isEditing()) await load(state.week);
  } catch { /* server stopped */ }
}, 2000);

load(state.week).catch(e => { state.loadError = e.message; render(); });
