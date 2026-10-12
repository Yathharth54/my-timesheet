import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { tmpHome, testConfig, makeItem, makeDraft } from './helpers.js';
import { FakeLinear, FakeEverhour } from './fakes.js';
import { saveConfig, saveDraft, readJsonl, loadDraft, writeJsonAtomic } from '../src/lib/store.js';
import { syncParents } from '../src/lib/parents.js';
import { paths } from '../src/lib/paths.js';
import { startServer } from '../src/server/server.js';
import { acquireWeekLock } from '../src/lib/lock.js';

const W = '2026-W41';
let srv: Awaited<ReturnType<typeof startServer>>;
const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(srv.url + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};

describe('review server', () => {
  let everhour: FakeEverhour;
  beforeEach(async () => {
    tmpHome();
    saveConfig(testConfig());
    saveDraft(syncParents(makeDraft({ week: W, rev: 0, items: [makeItem({ id: 'a', weight: 3 }), makeItem({ id: 'b', weight: 1 })] })));
    everhour = new FakeEverhour();
    srv = await startServer(0, {
      run: async () => '[{"id":"a","weight":3,"reason":"x"},{"id":"b","weight":1,"reason":"y"}]',
      clients: () => ({ linear: new FakeLinear(), everhour }),
      now: () => new Date('2026-10-06T10:00:00Z'),
    });
  });
  afterEach(async () => { await srv.close(); });

  it('removes a project, clears it from repos, and protects the last internal project', async () => {
    const { saveRepos, loadRepos, loadConfig } = await import('../src/lib/store.js');
    saveRepos({ '/r': { class: 'work', project: 'Boxsy', name: 'o/r' } });
    const r = await api('POST', '/api/projects/remove', { name: 'Boxsy' });
    expect(r.status).toBe(200);
    expect(r.json.projects.map((p: any) => p.name)).toEqual(['Dev - Internal']);
    expect(loadConfig()!.projects.map(p => p.name)).toEqual(['Dev - Internal']);
    expect(loadRepos()['/r'].project).toBeUndefined();
    const last = await api('POST', '/api/projects/remove', { name: 'Dev - Internal' });
    expect(last.status).toBe(400);
    expect(last.json.error).toMatch(/at least one project/);
    expect((await api('POST', '/api/projects/remove', { name: 'Nope' })).status).toBe(400);
  });

  it('will not remove the only internal project', async () => {
    const r = await api('POST', '/api/projects/remove', { name: 'Dev - Internal' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/only internal project/);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const port = new URL(srv.url).port;
    const status = await new Promise<number>(res => {
      http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example' } }, r => res(r.statusCode!));
    });
    expect(status).toBe(403);
  });

  it('serves state and returns 409 for a stale rev', async () => {
    const s = await api('GET', `/api/state?week=${W}`);
    expect(s.json.draft.items).toHaveLength(2);
    const stale = { ...s.json.draft, rev: s.json.draft.rev - 1 };
    const r = await api('PUT', '/api/draft', { draft: stale });
    expect(r.status).toBe(409);
    expect(r.json.draft.rev).toBe(s.json.draft.rev);
  });

  it('records bucket flips and rewrites as examples and marks edits', async () => {
    const { json } = await api('GET', `/api/state?week=${W}`);
    json.draft.items[0].project = 'Dev - Internal';
    json.draft.items[1].title = 'Better title';
    const r = await api('PUT', '/api/draft', { draft: json.draft });
    expect(r.status).toBe(200);
    expect(r.json.draft.items[1].edited).toBe(true);
    expect(readJsonl<any>(paths.examples()).map(e => e.kind).sort()).toEqual(['bucket', 'rewrite']);
  });

  it('refuses to change pushed items through PUT', async () => {
    const d = loadDraft(W)!;
    d.items[0].linear = { uuid: 'u', identifier: 'T-1', url: null, created: true };
    d.items[0].title = 'Pushed title';
    saveDraft(d);
    const { json } = await api('GET', `/api/state?week=${W}`);
    json.draft.items[0].title = 'Sneaky change';
    const r = await api('PUT', '/api/draft', { draft: json.draft });
    expect(r.json.draft.items[0].title).toBe('Pushed title');
  });

  it('distributes and reports clear errors for bad totals', async () => {
    let { json } = await api('GET', `/api/state?week=${W}`);
    json.draft.totalHours = 4;
    await api('PUT', '/api/draft', { draft: json.draft });
    const r = await api('POST', '/api/distribute', { week: W, reweight: false });
    expect(r.json.draft.items.map((i: any) => i.hours)).toEqual([3, 1]);
    json = (await api('GET', `/api/state?week=${W}`)).json;
    json.draft.totalHours = 3.3;
    await api('PUT', '/api/draft', { draft: json.draft });
    const bad = await api('POST', '/api/distribute', { week: W, reweight: false });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/multiple of 0.5h/);
  });

  it('runs a push in the background and reports awaiting_sync then done', async () => {
    let { json } = await api('GET', `/api/state?week=${W}`);
    json.draft.totalHours = 4;
    await api('PUT', '/api/draft', { draft: json.draft });
    await api('POST', '/api/distribute', { week: W, reweight: false });
    everhour.autoSync = false;
    expect((await api('POST', '/api/push', { week: W })).status).toBe(202);
    const waitFor = async (want: string) => {
      for (let i = 0; i < 50; i++) { const s = await api('GET', `/api/push?week=${W}`); if (s.json.status === want) return s.json; await new Promise(r => setTimeout(r, 20)); }
      throw new Error(`never reached ${want}`);
    };
    await waitFor('awaiting_sync');
    everhour.autoSync = true;
    await api('POST', '/api/push', { week: W });
    await waitFor('done');
    expect(loadDraft(W)!.pushed).toBe(true);
  });

  it('asks for confirmation when Everhour already has hours for the week, then pushes with confirm', async () => {
    let { json } = await api('GET', `/api/state?week=${W}`);
    json.draft.totalHours = 4;
    await api('PUT', '/api/draft', { draft: json.draft });
    await api('POST', '/api/distribute', { week: W, reweight: false });
    everhour.userSeconds = async () => 2 * 3600;
    const r = await api('POST', '/api/push', { week: W });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ needsConfirm: true, hours: 2 });
    expect((await api('GET', `/api/push?week=${W}`)).json.status).toBe('idle');
    expect((await api('POST', '/api/push', { week: W, confirm: true })).status).toBe(202);
    for (let i = 0; i < 50 && (await api('GET', `/api/push?week=${W}`)).json.status === 'running'; i++) await new Promise(r => setTimeout(r, 20));
    expect(loadDraft(W)!.pushed).toBe(true);
  });

  it('requires confirmation when the Everhour total cannot be read', async () => {
    everhour.userSeconds = async () => { throw new Error('HTTP 502'); };
    const r = await api('POST', '/api/push', { week: W });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ needsConfirm: true, hours: null });
  });

  it('refuses to start a push while the week is locked', async () => {
    const release = acquireWeekLock(W);
    try {
      const r = await api('POST', '/api/push', { week: W, confirm: true });
      expect(r.status).toBe(423);
      expect((await api('GET', `/api/push?week=${W}`)).json.status).toBe('idle');
    } finally { release(); }
  });

  it('returns 409 when the draft changes while weights are computed', async () => {
    const racing = await startServer(0, {
      run: async () => { saveDraft(loadDraft(W)!); return '[{"id":"a","weight":3,"reason":"x"},{"id":"b","weight":1,"reason":"y"}]'; },
      clients: () => ({ linear: new FakeLinear(), everhour }),
      now: () => new Date('2026-10-06T10:00:00Z'),
    });
    try {
      const d = loadDraft(W)!; d.totalHours = 4; saveDraft(d);
      const r = await fetch(racing.url + '/api/distribute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ week: W, reweight: true }) });
      const j = await r.json();
      expect(r.status).toBe(409);
      expect(j.error).toBe('The draft changed while weights were computed. Run Distribute again.');
      expect(j.draft.rev).toBe(loadDraft(W)!.rev);
      expect(loadDraft(W)!.items.every(i => i.hours == null)).toBe(true);
    } finally { await racing.close(); }
  });

  it('history skips weeks that have no draft yet', async () => {
    writeJsonAtomic(paths.evidence('2026-W42'), { commits: {}, sessions: {} });
    const r = await api('GET', '/api/history');
    expect(r.status).toBe(200);
    expect(r.json.map((w: { week: string }) => w.week)).toEqual([W]);
  });

  it('history sums live item hours per project', async () => {
    saveDraft(syncParents(makeDraft({ week: '2026-W40', rev: 0, items: [
      makeItem({ id: 'x', project: 'Boxsy', hours: 2 }),
      makeItem({ id: 'y', project: 'Boxsy', hours: 1.5 }),
      makeItem({ id: 'z', project: 'Dev - Internal', hours: 3 }),
      makeItem({ id: 'gone', project: 'Boxsy', hours: 9, deleted: true }),
      makeItem({ id: 'none', project: null, hours: 1 }),
    ] })));
    const r = await api('GET', '/api/history');
    const w40 = r.json.find((w: { week: string }) => w.week === '2026-W40');
    expect(w40.byProject).toEqual({ Boxsy: 3.5, 'Dev - Internal': 3 });
    expect(w40.total).toBe(7.5);
  });

  const raw = (method: string, p: string, headers: Record<string, string>, body?: string) =>
    fetch(srv.url + p, { method, headers, body }).then(async r => ({ status: r.status, json: await r.json() }));

  it('rejects non-JSON content types and foreign origins on writes', async () => {
    const t = await raw('POST', '/api/push', { 'Content-Type': 'text/plain' }, JSON.stringify({ week: W }));
    expect(t.status).toBe(415);
    expect((await api('GET', `/api/push?week=${W}`)).json.status).toBe('idle');
    const o = await raw('POST', '/api/push', { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, JSON.stringify({ week: W }));
    expect(o.status).toBe(403);
    expect((await api('GET', `/api/push?week=${W}`)).json.status).toBe('idle');
    const ok = await raw('POST', '/api/hours', { 'Content-Type': 'application/json', Origin: srv.url }, JSON.stringify({ week: W, id: 'a', hours: 1 }));
    expect(ok.status).toBe(200);
  });

  it('keeps pushed items, pre-saved uuids and server-owned fields on PUT', async () => {
    const d = loadDraft(W)!;
    d.items[0].linear = { uuid: 'u', identifier: 'T-1', url: null, created: true };
    d.items[1].linear = { uuid: 'pre', identifier: '', url: null, created: false } as any;
    saveDraft(d);
    const { json } = await api('GET', `/api/state?week=${W}`);
    const inc = json.draft;
    inc.items = [inc.items[1]];
    inc.items[0].linear = { uuid: 'changed', identifier: '', url: null, created: false };
    inc.pushed = true;
    const r = await api('PUT', '/api/draft', { draft: inc });
    expect(r.status).toBe(200);
    const saved = loadDraft(W)!;
    expect(saved.items.map(i => i.id).sort()).toEqual(['a', 'b']);
    expect(saved.items.find(i => i.id === 'b')!.linear!.uuid).toBe('pre');
    expect(saved.pushed).toBe(false);
  });

  it('returns 423 for edits while a push is running', async () => {
    let { json } = await api('GET', `/api/state?week=${W}`);
    json.draft.totalHours = 4;
    await api('PUT', '/api/draft', { draft: json.draft });
    await api('POST', '/api/distribute', { week: W, reweight: false });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    class GatedLinear extends FakeLinear {
      override async createIssue(input: Parameters<FakeLinear['createIssue']>[0]) { await gate; return super.createIssue(input); }
    }
    const linear = new GatedLinear();
    const gated = await startServer(0, { run: async () => '[]', clients: () => ({ linear, everhour }), now: () => new Date('2026-10-06T10:00:00Z') });
    const g = async (method: string, p: string, body?: unknown) => {
      const r = await fetch(gated.url + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: await r.json() };
    };
    try {
      expect((await g('POST', '/api/push', { week: W })).status).toBe(202);
      const s = (await g('GET', `/api/state?week=${W}`)).json;
      expect((await g('PUT', '/api/draft', { draft: s.draft })).status).toBe(423);
      expect((await g('POST', '/api/hours', { week: W, id: 'a', hours: 1 })).status).toBe(423);
      expect((await g('POST', '/api/delete', { week: W, id: 'a' })).status).toBe(423);
      expect((await g('POST', '/api/bulk', { week: W, ops: [{ op: 'delete', ids: ['a'] }] })).status).toBe(423);
      expect((await g('POST', '/api/remove', { week: W, ids: ['a'], confirm: true })).status).toBe(423);
      // another server process sees only the week lock
      const other = await api('POST', '/api/distribute', { week: W, reweight: false });
      expect(other.status).toBe(423);
      expect(other.json.error).toMatch(/is busy/);
    } finally {
      release();
      for (let i = 0; i < 100 && (await g('GET', `/api/push?week=${W}`)).json.status === 'running'; i++) await new Promise(r => setTimeout(r, 20));
      await gated.close();
    }
  });

  it('adds one issue on several days with hours, and keeps every day in step through PUT /api/draft', async () => {
    const r = await api('POST', '/api/items', { week: W, title: 'Team sync', description: 'Weekly sync.', project: 'Dev - Internal', days: ['2026-10-09', '2026-10-06'], hours: 1 });
    expect(r.status).toBe(200);
    const added = r.json.draft.items.slice(2);
    expect(added.map((i: any) => [i.day, i.hours, i.locked, i.sameAs ?? null])).toEqual([['2026-10-06', 1, true, null], ['2026-10-09', 1, true, added[0].id]]);
    expect(r.json.draft.parents.map((p: any) => p.key)).toEqual(['2026-10-05|Boxsy', '2026-10-06|Dev - Internal']);
    const d = r.json.draft;
    d.items[2].title = 'Standup'; // the client renames every day; a stale copy must still follow the home
    const put = await api('PUT', '/api/draft', { draft: d });
    expect(put.json.draft.items.slice(2).map((i: any) => i.title)).toEqual(['Standup', 'Standup']);
    expect(readJsonl<any>(paths.examples())).toHaveLength(1);
  });

  it('applies bulk ops in one save, logs corrections and rejects a stale rev', async () => {
    const { json } = await api('GET', `/api/state?week=${W}`);
    const r = await api('POST', '/api/bulk', { week: W, rev: json.draft.rev, ops: [{ op: 'set', ids: ['a', 'b'], project: 'Dev - Internal' }] });
    expect(r.status).toBe(200);
    expect(r.json.draft.rev).toBe(json.draft.rev + 1);
    expect(r.json.draft.items.every((i: any) => i.project === 'Dev - Internal')).toBe(true);
    expect(r.json.summary).toEqual(['Move 2 issues to Dev - Internal']);
    expect(r.json.draft.parents.map((p: any) => p.key)).toEqual(['2026-10-05|Dev - Internal']);
    expect(readJsonl<any>(paths.examples()).map(e => e.kind)).toEqual(['bucket', 'bucket']);
    const stale = await api('POST', '/api/bulk', { week: W, rev: json.draft.rev, ops: [{ op: 'delete', ids: ['a'] }] });
    expect(stale.status).toBe(409);
    expect(stale.json.draft.rev).toBe(r.json.draft.rev);
    expect((await api('POST', '/api/bulk', { week: W, ops: [{ op: 'set', ids: ['a'], project: 'Nope' }] })).status).toBe(400);
  });

  it('deletes pushed issues only with confirm, clearing Everhour and trashing in Linear', async () => {
    const d = loadDraft(W)!;
    d.items[0].linear = { uuid: 'ua', identifier: 'THE-1', url: null, created: true };
    d.items[0].everhour = { logged: true };
    d.items[0].hours = 2;
    d.parents[0].linear = { uuid: 'up', identifier: 'THE-0', url: null, created: true };
    saveDraft(d);
    const linear = new FakeLinear();
    const own = await startServer(0, { clients: () => ({ linear, everhour }), now: () => new Date('2026-10-06T10:00:00Z') });
    const post = async (p: string, body: unknown) => {
      const r = await fetch(own.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    try {
      expect((await post('/api/remove', { week: W, ids: ['a'] })).status).toBe(400);
      const bulk = await post('/api/bulk', { week: W, ops: [{ op: 'delete', ids: ['a'] }] });
      expect(bulk.json.remote).toEqual(['a']);
      expect(bulk.json.draft.items[0].deleted).toBe(false);
      const r = await post('/api/remove', { week: W, ids: ['a'], confirm: true });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ removed: ['a'], parents: [], failed: [] }); // b still sits under that parent
      expect(r.json.draft.items[0].deleted).toBe(true);
      expect(everhour.times.get('ua|2026-10-05')).toBe(0);
      expect(linear.trashed.has('ua')).toBe(true);
    } finally { await own.close(); }
  });

  it('asks Claude for ops and validates them without applying', async () => {
    const replies = [
      '```json\n{"reply":"Moving both to internal.","ops":[{"op":"set","ids":["a","b"],"project":"Dev - Internal"}]}\n```',
      '{"reply":"Deleting it.","ops":[{"op":"delete","ids":["ghost"]}]}',
      'I am not sure what you mean.',
    ];
    const prompts: string[] = [];
    const own = await startServer(0, { run: async p => { prompts.push(p); return replies.shift()!; }, clients: () => ({ linear: new FakeLinear(), everhour }), now: () => new Date('2026-10-06T10:00:00Z') });
    const post = async (body: unknown) => (await fetch(own.url + '/api/assist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    try {
      const ok = await post({ week: W, message: 'move all to internal' });
      expect(ok).toMatchObject({ reply: 'Moving both to internal.', summary: ['Move 2 issues to Dev - Internal'], remote: [] });
      expect(ok.ops).toHaveLength(1);
      expect(loadDraft(W)!.items[0].project).toBe('Boxsy');
      const bad = await post({ week: W, message: 'delete ghost', history: [{ message: 'move all to internal', reply: 'Moving both to internal.' }] });
      expect(bad.ops).toEqual([]);
      expect(bad.reply).toMatch(/No issue with id ghost/);
      expect(prompts[1]).toContain('Person: move all to internal');
      const junk = await post({ week: W, message: '??' });
      expect(junk).toMatchObject({ ops: [], reply: expect.stringMatching(/didn't return/) });
    } finally { await own.close(); }
  });
});
