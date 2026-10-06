const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const linearLink = l => /^https?:\/\//i.test(l?.url ?? '') ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.identifier)}</a>` : esc(l?.identifier);
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = d => WEEKDAY[new Date(`${d}T12:00:00`).getDay()];

const state = {
  week: new URLSearchParams(location.search).get('week'),
  draft: null, base: null, weeks: [], projects: [], warnings: [], push: { status: 'idle' },
  tab: 'week', focus: 0, editing: null, mergeFrom: null, armedDelete: null, everhour: null, saving: false, flash: '',
};

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, body: j });
  return j;
}

function flash(msg) { state.flash = msg; renderStatus(); setTimeout(() => { if (state.flash === msg) { state.flash = ''; renderStatus(); } }, 4000); }

function accept(res) {
  state.draft = res.draft;
  state.base = structuredClone(res.draft);
  state.warnings = res.warnings;
  render();
}

async function load(week) {
  const s = await api('GET', `/api/state${week ? `?week=${week}` : ''}`);
  state.week = s.week; state.weeks = s.weeks; state.projects = s.projects; state.push = s.push;
  history.replaceState(null, '', `?week=${s.week}`);
  accept(s);
  api('GET', `/api/everhour?week=${s.week}`).then(r => { state.everhour = r.hours; renderHeader(); }).catch(() => {});
}

const FIELDS = ['title', 'description', 'project', 'day', 'locked'];
function pendingPatches() {
  const base = new Map(state.base.items.map(i => [i.id, i]));
  const out = [];
  for (const i of state.draft.items) {
    const b = base.get(i.id);
    if (!b) continue;
    const patch = {};
    for (const f of FIELDS) if (JSON.stringify(i[f]) !== JSON.stringify(b[f])) patch[f] = i[f];
    if (Object.keys(patch).length) out.push([i.id, patch]);
  }
  const top = {};
  if (state.draft.totalHours !== state.base.totalHours) top.totalHours = state.draft.totalHours;
  if (JSON.stringify(state.draft.days) !== JSON.stringify(state.base.days)) top.days = state.draft.days;
  return { items: out, top };
}

let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); renderStatus(); }

async function save() {
  const pending = pendingPatches();
  if (!pending.items.length && !Object.keys(pending.top).length) return;
  state.saving = true; renderStatus();
  try {
    try {
      accept(await api('PUT', '/api/draft', { draft: state.draft }));
    } catch (e) {
      const server = e.body?.draft;
      if (e.status !== 409 || !server) throw e;
      const fresh = structuredClone(server);
      for (const [id, patch] of pending.items) { const it = fresh.items.find(x => x.id === id); if (it && !it.linear?.created) Object.assign(it, patch); }
      Object.assign(fresh, pending.top);
      state.base = structuredClone(server);
      state.draft = fresh;
      flash('draft changed elsewhere, your edits were re-applied');
      accept(await api('PUT', '/api/draft', { draft: state.draft })); // one retry only; state.saving stays true
    }
  } catch (e) {
    flash(e.message);
  } finally { state.saving = false; renderStatus(); }
}

async function act(url, body) {
  await save();
  try { accept(await api('POST', url, { week: state.week, ...body })); } catch (e) { flash(e.message); }
}

const live = () => state.draft.items.filter(i => !i.deleted);
function rows() {
  const out = [];
  for (const day of [...state.draft.days].sort()) {
    out.push({ kind: 'day', day });
    const its = live().filter(i => i.day === day);
    for (const project of [...new Set(its.map(i => i.project ?? ''))]) {
      const parent = state.draft.parents.find(p => p.key === `${day}|${project}`);
      out.push({ kind: 'parent', day, project, parent });
      for (const item of its.filter(i => (i.project ?? '') === project)) out.push({ kind: 'item', item });
    }
  }
  const stray = live().filter(i => !state.draft.days.includes(i.day));
  if (stray.length) { out.push({ kind: 'day', day: 'not counted' }); for (const item of stray) out.push({ kind: 'item', item }); }
  return out;
}
const itemRows = () => rows().filter(r => r.kind === 'item');
const focused = () => itemRows()[state.focus]?.item;

function renderHeader() {
  $('#weeklabel').textContent = state.week;
  $('#total').value = state.draft.totalHours ?? '';
  const all = (() => { const [y, w] = state.week.split('-W').map(Number); const j4 = new Date(Date.UTC(y, 0, 4)); const mon = new Date(j4); mon.setUTCDate(j4.getUTCDate() - ((j4.getUTCDay() + 6) % 7) + (w - 1) * 7); return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setUTCDate(mon.getUTCDate() + i); return d.toISOString().slice(0, 10); }); })();
  $('#days').innerHTML = all.map(d => `<button class="day ${state.draft.days.includes(d) ? 'on' : ''}" data-day="${esc(d)}">${dayName(d)[0]}</button>`).join('');
  $('#everhour').textContent = state.everhour == null ? '' : `already in everhour: ${state.everhour.toFixed(1)}h`;
  $('#warnings').innerHTML = state.warnings.map(w => `<div class="warn ${esc(w.level)}">${w.level === 'block' ? '✗' : '!'} ${esc(w.message)}</div>`).join('');
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
}

function renderWeek() {
  const fid = focused()?.id;
  const loadByDay = d => live().filter(i => i.day === d).reduce((s, i) => s + (i.hours ?? 0), 0);
  $('#view').innerHTML = rows().map(r => {
    if (r.kind === 'day') return `<div class="row day" data-dropday="${esc(r.day)}">▾ ${r.day === 'not counted' ? 'NOT COUNTED' : `${dayName(r.day).toUpperCase()} ${esc(r.day)}`}<span class="num">${r.day === 'not counted' ? '' : loadByDay(r.day).toFixed(1) + 'h'}</span></div>`;
    if (r.kind === 'parent') return `<div class="row parent">├─ <span class="proj">${esc(r.project || 'unassigned')}</span> <span class="ptitle" data-parent="${esc(r.parent?.key ?? '')}">${esc(r.parent?.title ?? '')}</span>${r.parent?.linear?.created ? ` ${linearLink(r.parent.linear)}` : ''}</div>`;
    const i = r.item;
    const pushed = !!i.linear?.created;
    const editing = state.editing === i.id;
    const cls = ['row', 'item', i.id === fid ? 'focus' : '', pushed ? 'pushed' : '', state.mergeFrom === i.id ? 'marked' : ''].join(' ');
    return `<div class="${cls}" data-id="${esc(i.id)}" draggable="${!pushed}">
      <div class="line">│  ${i.id === fid ? '<span class="cursor">█</span>' : ' '} ${editing ? `<input class="edit-title" value="${esc(i.title)}">` : `<span class="title">${esc(i.title)}</span>`}
        <span class="proj">[${esc(i.project ?? '—')}]</span>
        <span class="num">${i.hours == null ? '  —' : i.hours.toFixed(1)}h</span>${i.locked ? '<span class="lock" title="locked">L</span>' : ''}
        ${pushed ? linearLink(i.linear) : ''}</div>
      ${editing ? `<textarea class="edit-desc" rows="3">${esc(i.description)}</textarea>` : `<div class="desc dim">${esc(i.description)}</div>`}
      <div class="why dim">${esc(i.bucketReason)}${i.weightReason ? ` · weight ${esc(i.weight)}: ${esc(i.weightReason)}` : ''}${i.evidence.manual ? ' · added by hand' : ` · ${i.evidence.commits.length} commits, ${i.evidence.sessions.length} sessions`}</div>
    </div>`;
  }).join('') + `<div class="row add">+ add item <span class="dim">(a)</span></div>`;
  if (state.editing) $('.edit-title')?.focus();
}

async function renderSettings() {
  const s = await api('GET', '/api/settings');
  $('#view').innerHTML = `
    <h3>projects</h3>${s.projects.map(p => `<div class="row">${esc(p.name)} <select data-kind="${esc(p.name)}"><option ${p.kind === 'billable' ? 'selected' : ''}>billable</option><option ${p.kind === 'internal' ? 'selected' : ''}>internal</option></select></div>`).join('')}
    <h3>repos</h3>${s.repos.map(r => `<div class="row"><span class="dim">${esc(r.name ?? r.root)}</span> <select data-repo="${esc(r.root)}">${['work', 'personal', 'ignore'].map(c => `<option ${r.class === c ? 'selected' : ''}>${c}</option>`).join('')}</select> <select data-repoproj="${esc(r.root)}"><option value="">—</option>${s.projects.filter(p => p.kind === 'billable').map(p => `<option ${r.project === p.name ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>`).join('')}
    <h3>work orgs</h3><input id="orgs" value="${esc(s.workOrgs.join(', '))}">
    <h3>sunday reminder</h3><label><input type="checkbox" id="nudge" ${s.nudge ? 'checked' : ''}> remind me</label>
    <div><button id="savesettings" class="accent">save settings</button> <span class="dim">keys: run <code>timesheet init</code> to reconnect</span></div>`;
  $('#savesettings').onclick = async () => {
    await api('PUT', '/api/settings', {
      projects: [...document.querySelectorAll('[data-kind]')].map(el => ({ name: el.dataset.kind, kind: el.value })),
      repos: [...document.querySelectorAll('[data-repo]')].map(el => ({ root: el.dataset.repo, class: el.value, project: document.querySelector(`[data-repoproj="${CSS.escape(el.dataset.repo)}"]`).value || undefined })),
      workOrgs: $('#orgs').value.split(',').map(s => s.trim()).filter(Boolean),
      nudge: $('#nudge').checked,
    });
    flash('settings saved');
  };
}

async function renderHistory() {
  const h = await api('GET', '/api/history');
  $('#view').innerHTML = h.map(w => `<div class="row hist" data-week="${esc(w.week)}">${esc(w.week)}<span class="num">${w.total.toFixed(1)}h</span> <span class="dim">${w.items} items · ${w.pushed ? 'pushed' : 'not pushed'}</span></div>`).join('') || '<div class="dim">no weeks yet</div>';
}

function renderStatus() {
  if (!state.draft) return;
  const t = live().reduce((s, i) => s + (i.hours ?? 0), 0);
  const by = {};
  for (const i of live()) by[i.project ?? 'unassigned'] = (by[i.project ?? 'unassigned'] ?? 0) + (i.hours ?? 0);
  const blocks = state.warnings.filter(w => w.level === 'block').length;
  const pend = pendingPatches();
  const saved = state.saving ? '… saving' : (pend.items.length || Object.keys(pend.top).length ? '● unsaved' : '✓ saved');
  $('#status').innerHTML = [state.week.replace(/^\d{4}-/, ''), `${t.toFixed(1)}h`, ...Object.entries(by).map(([p, h]) => `${esc(p.toLowerCase())} ${h.toFixed(1)}`), `${live().length} items`, state.draft.weightsSource ? `weights: ${state.draft.weightsSource}` : null, blocks ? `<span class="bad">${blocks} blocking</span>` : null, saved, state.flash ? `<span class="accent-text">${esc(state.flash)}</span>` : null].filter(Boolean).join(' · ') + `<span class="right">push ▸ P · help ?</span>`;
}

function renderPush() {
  const p = state.push;
  const el = $('#pushpanel');
  if (!p || p.status === 'idle') { el.hidden = true; return; }
  el.hidden = false;
  const lines = {
    running: `<span class="spin">⠋</span> ${esc(p.phase ?? '')} ${p.done ?? 0}/${p.total ?? 0}`,
    awaiting_sync: `! ${p.missing.length} issues not in Everhour yet. Open Everhour → Projects → ${esc([...new Set(p.missing.map(m => m.project))].join(', '))} → Sync, then <button id="continue" class="accent">continue</button>`,
    done: `✓ pushed · ${esc(state.week)}`,
    blocked: `✗ blocked: ${esc(p.warnings.map(w => w.message).join('; '))}`,
    error: `✗ ${esc(p.error)} <button id="continue">retry</button>`,
  };
  el.innerHTML = lines[p.status] ?? '';
  $('#continue')?.addEventListener('click', startPush);
}

function render() {
  renderHeader();
  if (state.tab === 'week') renderWeek();
  else if (state.tab === 'settings') renderSettings();
  else renderHistory();
  renderStatus();
  renderPush();
}

async function startPush() {
  await save();
  try { await api('POST', '/api/push', { week: state.week }); } catch (e) { return flash(e.message); }
  const poll = async () => {
    state.push = await api('GET', `/api/push?week=${state.week}`);
    renderPush();
    if (state.push.status === 'running') setTimeout(poll, 400);
    else await load(state.week);
  };
  poll();
}

function edit(id) { state.editing = id; renderWeek(); }
function commitEdit() {
  const it = state.draft.items.find(i => i.id === state.editing);
  if (it) { it.title = $('.edit-title').value.trim() || it.title; it.description = $('.edit-desc').value.trim() || it.description; }
  state.editing = null; renderWeek(); scheduleSave();
}

function addItem() {
  const day = focused()?.day ?? state.draft.days[0];
  const row = document.createElement('div');
  row.className = 'row additem';
  row.innerHTML = `<input id="newtitle" placeholder="title (2–3 words)"> <input id="newdesc" placeholder="description"> <select id="newproj">${state.projects.map(p => `<option>${esc(p.name)}</option>`).join('')}</select> <select id="newday">${state.draft.days.map(d => `<option ${d === day ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select> <button id="newok" class="accent">add</button>`;
  $('#view').appendChild(row);
  $('#newtitle').focus();
  $('#newok').onclick = () => act('/api/items', { title: $('#newtitle').value, description: $('#newdesc').value, project: $('#newproj').value, day: $('#newday').value });
}

const HELP = [['j / k', 'move'], ['e', 'edit title + description (Enter save, Esc cancel)'], ['p', 'cycle project'], ['[ / ]', 'hours −/+ 0.5 (locks item)'], ['L', 'lock / unlock hours'], ['d d', 'delete'], ['m', 'mark, then m on another item to merge'], ['s', 'split into 2'], ['a', 'add item'], ['D', 'distribute'], ['P', 'push'], ['/', 'command palette'], ['?', 'this help']];

document.addEventListener('keydown', e => {
  if (state.editing) {
    if (e.key === 'Escape') { state.editing = null; renderWeek(); }
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); commitEdit(); }
    if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); commitEdit(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
    if (e.key === 'Escape') { e.target.blur(); $('#palette').hidden = true; }
    return;
  }
  if (state.tab !== 'week' && !['/', '?'].includes(e.key)) return;
  const it = focused();
  const n = itemRows().length;
  const k = e.key;
  if (k === 'j') state.focus = Math.min(n - 1, state.focus + 1);
  else if (k === 'k') state.focus = Math.max(0, state.focus - 1);
  else if (k === 'e' && it && !it.linear) { e.preventDefault(); return edit(it.id); }
  else if (k === 'p' && it && !it.linear) { const names = state.projects.map(p => p.name); it.project = names[(names.indexOf(it.project) + 1) % names.length]; scheduleSave(); }
  else if ((k === '[' || k === ']') && it && !it.linear) return act('/api/hours', { id: it.id, hours: Math.max(0.5, (it.hours ?? 0.5) + (k === ']' ? 0.5 : -0.5)) });
  else if (k === 'L' && it && !it.linear) { it.locked = !it.locked; scheduleSave(); }
  else if (k === 'd' && it && !it.linear) { if (state.armedDelete === it.id) { state.armedDelete = null; return act('/api/delete', { id: it.id }); } state.armedDelete = it.id; flash('press d again to delete'); }
  else if (k === 'm' && it && !it.linear) { if (state.mergeFrom && state.mergeFrom !== it.id) { const ids = [state.mergeFrom, it.id]; state.mergeFrom = null; return act('/api/merge', { ids }); } state.mergeFrom = it.id; flash('marked, press m on another item to merge'); }
  else if (k === 's' && it && !it.linear) return act('/api/split', { id: it.id, parts: 2 });
  else if (k === 'a') { e.preventDefault(); return addItem(); }
  else if (k === 'D') return act('/api/distribute', { reweight: false });
  else if (k === 'P') return startPush();
  else if (k === '/') { e.preventDefault(); $('#palette').hidden = false; $('#paletteinput').value = ''; return $('#paletteinput').focus(); }
  else if (k === '?') { const h = $('#help'); h.hidden = !h.hidden; h.innerHTML = HELP.map(([a, b]) => `<div><span class="key">${a}</span> ${b}</div>`).join(''); return; }
  else return;
  renderWeek(); renderStatus();
});

$('#paletteinput').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const [cmd, arg] = e.target.value.trim().split(/\s+/);
  $('#palette').hidden = true;
  if (cmd === 'distribute') act('/api/distribute', { reweight: false });
  else if (cmd === 'reweight') act('/api/distribute', { reweight: true });
  else if (cmd === 'push') startPush();
  else if (cmd === 'week' && arg) load(arg);
  else if (cmd === 'settings' || cmd === 'history' || cmd === 'week') { state.tab = cmd === 'week' ? 'week' : cmd; render(); }
});

document.addEventListener('click', e => {
  if (state.editing && e.target.closest('.edit-title, .edit-desc')) return;
  const t = e.target.closest('button, .row.item, .row.add, .row.hist');
  if (!t) return;
  if (t.dataset.tab) { state.tab = t.dataset.tab; return render(); }
  if (t.dataset.day) { const d = state.draft.days; state.draft.days = d.includes(t.dataset.day) ? d.filter(x => x !== t.dataset.day) : [...d, t.dataset.day].sort(); renderWeek(); renderHeader(); return scheduleSave(); }
  if (t.id === 'distribute') return act('/api/distribute', { reweight: false });
  if (t.id === 'reweight') return act('/api/distribute', { reweight: true });
  if (t.id === 'prev' || t.id === 'next') { const [y, w] = state.week.split('-W').map(Number); const d = new Date(Date.UTC(y, 0, 4 + (w - 1) * 7 + (t.id === 'next' ? 7 : -7))); return load(isoWeek(d)); }
  if (t.classList.contains('item')) { state.focus = itemRows().findIndex(r => r.item.id === t.dataset.id); renderWeek(); renderStatus(); }
  if (t.classList.contains('add')) addItem();
  if (t.classList.contains('hist')) { state.tab = 'week'; load(t.dataset.week); }
});

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - dow + 3);
  const y = t.getUTCFullYear(); const j4 = new Date(Date.UTC(y, 0, 4));
  return `${y}-W${String(1 + Math.round(((t - j4) / 86400000 - 3 + ((j4.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
}

$('#total').addEventListener('change', e => {
  const v = e.target.value.trim() === '' ? null : Number(e.target.value);
  if (v !== null && !(v > 0)) return flash('total must be a positive number');
  state.draft.totalHours = v; scheduleSave();
});

document.addEventListener('dragstart', e => { const r = e.target.closest('.row.item'); if (r) e.dataTransfer.setData('text/plain', r.dataset.id); });
document.addEventListener('dragover', e => { if (e.target.closest('[data-dropday]')) e.preventDefault(); });
document.addEventListener('drop', e => {
  const target = e.target.closest('[data-dropday]');
  if (!target || target.dataset.dropday === 'not counted') return;
  e.preventDefault();
  const it = state.draft.items.find(i => i.id === e.dataTransfer.getData('text/plain'));
  if (it && !it.linear) { it.day = target.dataset.dropday; renderWeek(); scheduleSave(); }
});

setInterval(async () => {
  if (!state.draft || state.saving) return;
  try {
    const { rev } = await api('GET', `/api/rev?week=${state.week}`);
    if (rev > state.base.rev && !pendingPatches().items.length && !state.editing) await load(state.week);
  } catch { /* server stopped */ }
}, 2000);

load(state.week).catch(e => { $('#view').innerHTML = `<div class="bad">✗ ${esc(e.message)}</div>`; });
