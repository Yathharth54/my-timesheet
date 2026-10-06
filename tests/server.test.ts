import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { tmpHome, testConfig, makeItem, makeDraft } from './helpers.js';
import { FakeLinear, FakeEverhour } from './fakes.js';
import { saveConfig, saveDraft, readJsonl, loadDraft } from '../src/lib/store.js';
import { syncParents } from '../src/lib/parents.js';
import { paths } from '../src/lib/paths.js';
import { startServer } from '../src/server/server.js';

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
});
