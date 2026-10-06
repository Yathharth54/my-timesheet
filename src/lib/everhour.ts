import { request, type RetryOpts } from './http.js';

const BASE = 'https://api.everhour.com';

export class Everhour {
  constructor(private apiKey: string, private opts: RetryOpts = {}) {}

  private req(method: string, p: string, body?: unknown) {
    return request(BASE + p, {
      method,
      headers: { 'X-Api-Key': this.apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, this.opts);
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

  /** POST /time upserts one record per (user, date, task), so repeating it is safe. */
  async addTime(a: { issueUuid: string; userId: number; date: string; hours: number }): Promise<void> {
    const { status } = await this.req('POST', '/time', { task: `li:${a.issueUuid}`, user: a.userId, date: a.date, time: Math.round(a.hours * 3600) });
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
