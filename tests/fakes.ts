import type { LinearApi, CreateIssueInput } from '../src/lib/linear.js';
import type { EverhourApi } from '../src/lib/everhour.js';

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

export class FakeEverhour implements EverhourApi {
  autoSync = true;
  known = new Set<string>();
  times = new Map<string, number>();
  posts = 0;
  syncs: string[] = [];
  failEvery = 0;
  private calls = 0;
  private tick() { this.calls++; if (this.failEvery && this.calls % this.failEvery === 0) throw new Error('HTTP 502'); }
  async syncProject(id: string) { this.syncs.push(id); }
  async taskExists(uuid: string) { this.tick(); return this.autoSync || this.known.has(uuid); }
  async addTime(a: { issueUuid: string; userId: number; date: string; hours: number }) {
    this.tick();
    this.posts++;
    this.times.set(`${a.issueUuid}|${a.date}`, a.hours);
  }
  async userSeconds() { return 0; }
}
