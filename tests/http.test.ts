import { describe, it, expect } from 'vitest';
import { request, HttpError } from '../src/lib/http.js';

const res = (status: number, body = '{}', headers: Record<string, string> = {}) => new Response(body, { status, headers });

describe('request', () => {
  it('retries 429 using Retry-After, then succeeds', async () => {
    const waits: number[] = [];
    const queue = [res(429, '', { 'retry-after': '2' }), res(503), res(200, '{"ok":true}')];
    const r = await request('https://x', {}, { fetchImpl: async () => queue.shift()!, sleep: async ms => { waits.push(ms); }, baseMs: 10 });
    expect(r).toEqual({ status: 200, json: { ok: true } });
    expect(waits).toEqual([2000, 20]);
  });
  it('returns 404 without throwing and throws HttpError on 401', async () => {
    expect(await request('https://x', {}, { fetchImpl: async () => res(404) })).toEqual({ status: 404, json: null });
    await expect(request('https://x', {}, { fetchImpl: async () => res(401, 'bad key') })).rejects.toBeInstanceOf(HttpError);
  });
  it('retries network errors then gives up', async () => {
    let calls = 0;
    await expect(request('https://x', {}, { fetchImpl: async () => { calls++; throw new TypeError('fetch failed'); }, sleep: async () => {}, retries: 2 })).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(3);
  });
});
