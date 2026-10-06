import { randomUUID } from 'node:crypto';
import { validate } from './validate.js';
import { parentKey, syncParents } from './parents.js';
import type { CreateIssueInput, LinearApi } from './linear.js';
import type { EverhourApi } from './everhour.js';
import type { Config, Draft, Item, LinearRef, Warning } from './types.js';

export type PushEvent = { phase: 'parents' | 'issues' | 'sync' | 'time'; done: number; total: number };
export type PushResult =
  | { status: 'blocked'; warnings: Warning[] }
  | { status: 'awaiting_sync'; missing: { identifier: string; project: string }[] }
  | { status: 'done'; issues: number; hours: number };

export interface PushDeps {
  linear: LinearApi;
  everhour: EverhourApi;
  config: Config;
  save: (d: Draft) => void;
  newUuid?: () => string;
  onProgress?: (e: PushEvent) => void;
  concurrency?: number;
}

/**
 * Runs fn with at most n in flight. After the first failure no new items start, and the call waits for all
 * in-flight workers to settle before rethrowing the first error, so no stale save() can run after rejection.
 */
export async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (!failed && next < items.length) {
      const t = items[next++];
      try { await fn(t); } catch (e) { if (!failed) { failed = true; firstError = e; } return; }
    }
  });
  await Promise.all(workers);
  if (failed) throw firstError;
}

export async function push(draft: Draft, deps: PushDeps): Promise<PushResult> {
  const { config } = deps;
  const newUuid = deps.newUuid ?? randomUUID;
  const conc = deps.concurrency ?? 5;
  const progress = (phase: PushEvent['phase'], done: number, total: number) => deps.onProgress?.({ phase, done, total });

  const blocks = validate(draft, config.projects.map(p => p.name)).filter(w => w.level === 'block');
  if (blocks.length) return { status: 'blocked', warnings: blocks };

  const project = (name: string) => {
    const p = config.projects.find(x => x.name === name);
    if (!p) throw new Error(`Unknown project "${name}".`);
    return p;
  };

  const ensure = async (holder: { linear: LinearRef | null }, input: Omit<CreateIssueInput, 'id'>): Promise<LinearRef> => {
    if (!holder.linear) {
      holder.linear = { uuid: newUuid(), identifier: null, url: null, created: false };
      deps.save(draft);
    }
    if (holder.linear.created) return holder.linear;
    const found = await deps.linear.getIssue(holder.linear.uuid);
    const ref = found ?? (await deps.linear.createIssue({ ...input, id: holder.linear.uuid }));
    holder.linear = { uuid: ref.uuid, identifier: ref.identifier, url: ref.url, created: true };
    deps.save(draft);
    return holder.linear;
  };

  // The sync check is read-only, so transient errors are retried in-run. Otherwise a flaky API could keep a
  // push from ever getting through all items in one run, since time is only logged after every task is confirmed.
  const existsWithRetry = async (uuid: string): Promise<boolean> => {
    for (let attempt = 1; ; attempt++) {
      try { return await deps.everhour.taskExists(uuid); } catch (e) { if (attempt >= 3) throw e; }
    }
  };

  const pending: Item[] = draft.items.filter(i => !i.deleted && !i.everhour?.logged);
  if (pending.length && draft.pushed) {
    // An extra batch is unfinished until it's done, so status, History and the nudge show it.
    draft.pushed = false;
    deps.save(draft);
  }
  syncParents(draft);

  const keys = [...new Set(pending.map(i => parentKey(i.day, i.project!)))];
  let done = 0;
  for (const key of keys) {
    const parent = draft.parents.find(p => p.key === key)!;
    const p = project(key.split('|')[1]);
    await ensure(parent, {
      teamId: p.teamId, projectId: p.id, assigneeId: config.linear.assigneeId, stateId: p.stateId, labelIds: p.labelIds,
      title: parent.title, description: parent.description,
    });
    progress('parents', ++done, keys.length);
  }

  done = 0;
  await pool(pending, conc, async item => {
    const p = project(item.project!);
    const parent = draft.parents.find(x => x.key === parentKey(item.day, item.project!))!;
    await ensure(item, {
      teamId: p.teamId, projectId: p.id, assigneeId: config.linear.assigneeId, stateId: p.stateId, labelIds: p.labelIds,
      parentId: parent.linear!.uuid, title: item.title, description: item.description,
    });
    progress('issues', ++done, pending.length);
  });

  for (const id of new Set(pending.map(i => project(i.project!).id))) await deps.everhour.syncProject(id);
  const missing: Item[] = [];
  done = 0;
  await pool(pending, conc, async item => {
    if (!(await existsWithRetry(item.linear!.uuid))) missing.push(item);
    progress('sync', ++done, pending.length);
  });
  if (missing.length) {
    return { status: 'awaiting_sync', missing: missing.map(i => ({ identifier: i.linear!.identifier ?? i.title, project: i.project! })) };
  }

  done = 0;
  await pool(pending, Math.min(conc, 3), async item => {
    await deps.everhour.addTime({ issueUuid: item.linear!.uuid, userId: config.everhour.userId, date: item.day, hours: item.hours! });
    item.everhour = { logged: true };
    deps.save(draft);
    progress('time', ++done, pending.length);
  });

  draft.pushed = true;
  deps.save(draft);
  return { status: 'done', issues: pending.length, hours: pending.reduce((s, i) => s + (i.hours ?? 0), 0) };
}
