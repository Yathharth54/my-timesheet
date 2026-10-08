import { describe, it, expect } from 'vitest';
import { Everhour } from '../src/lib/everhour.js';

function fake(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: { method: string; url: string; body: any; headers: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const r = routes[`${init.method} ${url.replace('https://api.everhour.com', '')}`] ?? { status: 404 };
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('Everhour', () => {
  it('checks tasks by li:{uuid} and sets time with PUT /tasks/{id}/time', async () => {
    const f = fake({ 'GET /tasks/li:abc': { status: 200, body: { id: 'li:abc' } }, 'GET /tasks/li:missing': { status: 404 }, 'PUT /tasks/li:abc/time': { status: 200, body: {} } });
    const e = new Everhour('key', { fetchImpl: f.fetchImpl });
    expect(await e.taskExists('abc')).toBe(true);
    expect(await e.taskExists('missing')).toBe(false);
    await e.addTime({ issueUuid: 'abc', userId: 1400517, date: '2026-10-06', hours: 1.5 });
    const put = f.calls.find(c => c.method === 'PUT')!;
    expect(put.body).toEqual({ time: 5400, date: '2026-10-06', user: 1400517 });
    expect(put.headers['X-Api-Key']).toBe('key');
    expect(f.calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('sums user seconds and reports the Linear integration', async () => {
    const f = fake({
      'GET /users/1/time?from=2026-10-05&to=2026-10-11&limit=10000': { status: 200, body: [{ time: 3600 }, { time: 1800 }] },
      'GET /users/me': { status: 200, body: { id: 1, name: 'Y', email: 'y@x', accounts: [{ platform: 'li' }] } },
    });
    const e = new Everhour('k', { fetchImpl: f.fetchImpl });
    expect(await e.userSeconds(1, '2026-10-05', '2026-10-11')).toBe(5400);
    expect(await e.me()).toEqual({ id: 1, name: 'Y', email: 'y@x', linearConnected: true });
  });

  it('syncProject never throws', async () => {
    const f = fake({ 'POST /projects/li:p/sync': { status: 400, body: { message: 'bad' } } });
    await expect(new Everhour('k', { fetchImpl: f.fetchImpl }).syncProject('p')).resolves.toBeUndefined();
  });

  it('addTime rejects when setting time returns 404', async () => {
    const f = fake({});
    const e = new Everhour('k', { fetchImpl: f.fetchImpl });
    await expect(e.addTime({ issueUuid: 'xyz', userId: 1, date: '2026-10-06', hours: 1 })).rejects.toThrow('setting time returned 404 for li:xyz');
  });

  it('reads existing time records for a day, handling both task shapes', async () => {
    const f = fake({ 'GET /users/7/time?from=2026-10-06&to=2026-10-06&limit=10000': { status: 200, body: [
      { task: { id: 'li:a', name: 'A' }, date: '2026-10-06', time: 3600, user: 7 },
      { task: 'li:b', date: '2026-10-06', time: 1800, user: 7 },
      { date: '2026-10-06', time: 900, user: 7 },
    ] } });
    const e = new Everhour('k', { fetchImpl: f.fetchImpl });
    expect(await e.timeFor(7, '2026-10-06')).toEqual([{ task: 'li:a', seconds: 3600 }, { task: 'li:b', seconds: 1800 }, { task: null, seconds: 900 }]);
  });

  it('addTime skips the write when the same time is already logged, and sets (not adds) a new value', async () => {
    const f = fake({
      'GET /users/1/time?from=2026-10-06&to=2026-10-06&limit=10000': { status: 200, body: [{ task: { id: 'li:abc' }, date: '2026-10-06', time: 5400, user: 1 }] },
      'PUT /tasks/li:abc/time': { status: 200, body: {} },
    });
    const e = new Everhour('k', { fetchImpl: f.fetchImpl });
    await e.addTime({ issueUuid: 'abc', userId: 1, date: '2026-10-06', hours: 1.5 });
    expect(f.calls.filter(c => c.method === 'PUT')).toHaveLength(0);
    await e.addTime({ issueUuid: 'abc', userId: 1, date: '2026-10-06', hours: 2 });
    expect(f.calls.filter(c => c.method === 'PUT').map(c => c.body.time)).toEqual([7200]);
  });

  it('retries setting time on a 5xx because PUT is safe to repeat', async () => {
    let n = 0;
    const fetchImpl = (async (_url: string, init: any) => {
      if (init.method === 'GET') return new Response('[]', { status: 200 });
      return new Response('{}', { status: ++n < 3 ? 503 : 200 });
    }) as unknown as typeof fetch;
    const e = new Everhour('k', { fetchImpl, sleep: async () => {} });
    await e.addTime({ issueUuid: 'abc', userId: 1, date: '2026-10-06', hours: 1 });
    expect(n).toBe(3);
  });

  it('taskExists rejects on authentication error', async () => {
    const f = fake({ 'GET /tasks/li:x': { status: 401 } });
    const e = new Everhour('k', { fetchImpl: f.fetchImpl });
    await expect(e.taskExists('x')).rejects.toThrow();
  });
});
