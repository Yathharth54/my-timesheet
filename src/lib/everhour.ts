import { request, type RetryOpts } from './http.js';

const BASE = 'https://api.everhour.com';

export interface AddTime { issueUuid: string; userId: number; date: string; hours: number }
export interface TimeRecord { task: string | null; seconds: number }

/**
 * Read-before-write, so a repeated call is safe whether POST /time upserts or adds (the smoke test verifies it
 * upserts). Same seconds already logged for (user, date, li:{uuid}) → no-op; none → POST; different → POST
 * (upsert intent). POST /time is never retried automatically: a lost response is resolved by the next run's read.
 */
export async function logTimeOnce(
  api: { timeFor(userId: number, date: string): Promise<TimeRecord[]>; postTime(a: AddTime): Promise<void> },
  a: AddTime,
): Promise<void> {
  const task = `li:${a.issueUuid}`;
  const existing = (await api.timeFor(a.userId, a.date)).filter(r => r.task === task);
  if (existing.length && existing.reduce((s, r) => s + r.seconds, 0) === Math.round(a.hours * 3600)) return;
  await api.postTime(a);
}

export class Everhour {
  constructor(private apiKey: string, private opts: RetryOpts = {}) {}

  private req(method: string, p: string, body?: unknown, opts: RetryOpts = {}) {
    return request(BASE + p, {
      method,
      headers: { 'X-Api-Key': this.apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { ...this.opts, ...opts });
  }

  async me(): Promise<{ id: number; name: string; email: string; linearConnected: boolean }> {
    const { json } = await this.req('GET', '/users/me');
    const accounts: unknown[] = json.accounts ?? json.integrations ?? [];
    const linearConnected = accounts.some(a => (typeof a === 'string' ? a : (a as { platform?: string })?.platform) === 'li');
    return { id: json.id, name: json.name, email: json.email, linearConnected };
  }

  async taskExists(issueUuid: string): Promise<boolean> {
    return (await this.req('GET', `/tasks/li:${issueUuid}`)).status !== 404;
  }

  /** Verified 2026-10-06: returns 200 but does not import new issues. Called anyway, best effort. */
  async syncProject(projectUuid: string): Promise<void> {
    try { await this.req('POST', `/projects/li:${projectUuid}/sync`); } catch { /* best effort */ }
  }

  /** Logs a.hours on li:{uuid} for that day, safe to repeat (see logTimeOnce). */
  addTime(a: AddTime): Promise<void> {
    return logTimeOnce(this, a);
  }

  /** The user's time records for one day. A record's task is `{ id: 'li:...' }` or a plain id string. */
  async timeFor(userId: number, date: string): Promise<TimeRecord[]> {
    const { json } = await this.req('GET', `/users/${userId}/time?from=${date}&to=${date}&limit=10000`);
    return (Array.isArray(json) ? json : []).map((r: { task?: { id?: string } | string; time?: number }) => ({
      task: (typeof r.task === 'string' ? r.task : r.task?.id) ?? null,
      seconds: Number(r.time) || 0,
    }));
  }

  /** One POST /time with no automatic retry. */
  async postTime(a: AddTime): Promise<void> {
    const { status } = await this.req('POST', '/time', { task: `li:${a.issueUuid}`, user: a.userId, date: a.date, time: Math.round(a.hours * 3600) }, { retries: 0 });
    if (status < 200 || status >= 300) {
      throw new Error(`Everhour: POST /time returned ${status} for li:${a.issueUuid}`);
    }
  }

  async userSeconds(userId: number, from: string, to: string): Promise<number> {
    const { json } = await this.req('GET', `/users/${userId}/time?from=${from}&to=${to}&limit=10000`);
    return (Array.isArray(json) ? json : []).reduce((s: number, r: { time?: number }) => s + (Number(r.time) || 0), 0);
  }
}

export type EverhourApi = Pick<Everhour, 'taskExists' | 'syncProject' | 'addTime'>;
