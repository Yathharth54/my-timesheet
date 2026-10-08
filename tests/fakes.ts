import type { LinearApi, CreateIssueInput } from '../src/lib/linear.js';
import { logTimeOnce, type AddTime, type EverhourApi, type TimeRecord } from '../src/lib/everhour.js';

export class FakeLinear implements LinearApi {
  issues = new Map<string, { input: CreateIssueInput; identifier: string }>();
  failEvery = 0;
  loseResponseEvery = 0;
  private calls = 0;
  private n = 0;
  private creates = 0;
  private tick() { this.calls++; if (this.failEvery && this.calls % this.failEvery === 0) throw new Error('HTTP 503'); }
  async getIssue(id: string) {
    this.tick();
    const i = this.issues.get(id);
    return i ? { uuid: id, identifier: i.identifier, url: `https://linear.app/t/${i.identifier}` } : null;
  }
  async createIssue(input: CreateIssueInput) {
    this.tick();
    if (this.issues.has(input.id)) throw new Error(`duplicate id ${input.id}`);
    const identifier = `T-${++this.n}`;
    this.issues.set(input.id, { input, identifier });
    this.creates++;
    if (this.loseResponseEvery && this.creates % this.loseResponseEvery === 0) throw new Error('socket hang up');
    return { uuid: input.id, identifier, url: `https://linear.app/t/${identifier}` };
  }
}

/** Everhour fake. setTime sets the exact value, as the real PUT /tasks/{id}/time does. */
export class FakeEverhour implements EverhourApi {
  autoSync = true;
  known = new Set<string>();
  /** hours per `${issueUuid}|${date}` */
  times = new Map<string, number>();
  posts = 0;
  syncs: string[] = [];
  failEvery = 0;
  /** every Nth setTime is stored but its response is lost */
  loseResponseEvery = 0;
  private calls = 0;
  private tick() { this.calls++; if (this.failEvery && this.calls % this.failEvery === 0) throw new Error('HTTP 502'); }
  async syncProject(id: string) { this.syncs.push(id); }
  async taskExists(uuid: string) { this.tick(); return this.autoSync || this.known.has(uuid); }
  async timeFor(_userId: number, date: string): Promise<TimeRecord[]> {
    this.tick();
    return [...this.times].filter(([k]) => k.endsWith(`|${date}`)).map(([k, h]) => ({ task: `li:${k.split('|')[0]}`, seconds: Math.round(h * 3600) }));
  }
  async setTime(a: AddTime) {
    this.tick();
    this.posts++;
    this.times.set(`${a.issueUuid}|${a.date}`, a.hours);
    if (this.loseResponseEvery && this.posts % this.loseResponseEvery === 0) throw new Error('socket hang up');
  }
  addTime(a: AddTime) { return logTimeOnce(this, a); }
  async userSeconds() { return 0; }
}
