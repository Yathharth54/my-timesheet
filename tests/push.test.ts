import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem, testConfig } from './helpers.js';
import { FakeLinear, FakeEverhour } from './fakes.js';
import { push, pool } from '../src/lib/push.js';
import { syncParents } from '../src/lib/parents.js';
import type { Draft } from '../src/lib/types.js';

function readyDraft(): Draft {
  const items = [
    makeItem({ id: 'a', title: 'Deck reader', day: '2026-10-05', project: 'Boxsy', hours: 3 }),
    makeItem({ id: 'b', title: 'Field mapper', day: '2026-10-05', project: 'Boxsy', hours: 2 }),
    makeItem({ id: 'c', title: 'Cache probe', day: '2026-10-05', project: 'Dev - Internal', hours: 1 }),
    makeItem({ id: 'd', title: 'Confirm screen', day: '2026-10-06', project: 'Boxsy', hours: 2.5 }),
  ];
  return syncParents(makeDraft({ totalHours: 8.5, items }));
}

let u = 0;
const newUuid = () => `uuid-${++u}`;

describe('push', () => {
  it('blocks on validation errors without calling any API', async () => {
    const linear = new FakeLinear();
    const r = await push(makeDraft({ items: [makeItem()] }), { linear, everhour: new FakeEverhour(), config: testConfig(), save: () => {}, newUuid });
    expect(r.status).toBe('blocked');
    expect(linear.issues.size).toBe(0);
  });

  it('creates parents then children with parentId, then logs time on sub-issues only', async () => {
    const linear = new FakeLinear();
    const everhour = new FakeEverhour();
    const d = readyDraft();
    const r = await push(d, { linear, everhour, config: testConfig(), save: () => {}, newUuid });
    expect(r).toEqual({ status: 'done', issues: 4, hours: 8.5 });
    expect(linear.issues.size).toBe(3 + 4);
    const child = [...linear.issues.values()].find(i => i.input.title === 'Deck reader')!;
    const parent = [...linear.issues.entries()].find(([id]) => id === child.input.parentId)![1];
    expect(child.input).toMatchObject({ teamId: 'team-box', projectId: 'proj-box', assigneeId: 'user-1', stateId: 'state-box' });
    expect(parent.input.parentId).toBeUndefined();
    expect(parent.input.description).toMatch(/2 sub-tasks\.$/);
    expect(everhour.times.size).toBe(4);
    expect(everhour.syncs.sort()).toEqual(['proj-box', 'proj-int']);
    expect(d.pushed).toBe(true);
  });

  it('waits for the manual Everhour sync before logging any time', async () => {
    const linear = new FakeLinear();
    const everhour = new FakeEverhour();
    everhour.autoSync = false;
    const d = readyDraft();
    const first = await push(d, { linear, everhour, config: testConfig(), save: () => {}, newUuid });
    expect(first.status).toBe('awaiting_sync');
    expect(everhour.posts).toBe(0);
    for (const i of d.items) everhour.known.add(i.linear!.uuid);
    const second = await push(d, { linear, everhour, config: testConfig(), save: () => {}, newUuid });
    expect(second.status).toBe('done');
    expect(linear.issues.size).toBe(7);
  });

  it('survives random failures and lost responses across restarts without duplicates', async () => {
    const linear = new FakeLinear();
    linear.failEvery = 4;
    linear.loseResponseEvery = 3;
    const everhour = new FakeEverhour();
    everhour.failEvery = 3;
    everhour.loseResponseEvery = 2;
    let saved = structuredClone(readyDraft());
    let result;
    for (let run = 0; run < 100; run++) {
      const d = structuredClone(saved);
      try {
        result = await push(d, { linear, everhour, config: testConfig(), save: x => { saved = structuredClone(x); }, newUuid, concurrency: 2 });
        if (result.status === 'done') break;
      } catch { /* simulate process restart */ }
    }
    expect(result?.status).toBe('done');
    expect(linear.issues.size).toBe(7);
    expect(everhour.times.size).toBe(4);
    expect([...everhour.times.values()].reduce((a, b) => a + b, 0)).toBe(8.5);
  });

  it('never doubles hours when a POST /time response is lost, even if Everhour adds', async () => {
    const linear = new FakeLinear();
    const everhour = new FakeEverhour();
    everhour.loseResponseEvery = 1;
    let saved = structuredClone(readyDraft());
    await expect(push(structuredClone(saved), { linear, everhour, config: testConfig(), save: x => { saved = structuredClone(x); }, newUuid, concurrency: 1 })).rejects.toThrow('socket hang up');
    everhour.loseResponseEvery = 0;
    const r = await push(structuredClone(saved), { linear, everhour, config: testConfig(), save: x => { saved = structuredClone(x); }, newUuid, concurrency: 1 });
    expect(r.status).toBe('done');
    expect(everhour.posts).toBe(4);
    expect([...everhour.times.values()].reduce((a, b) => a + b, 0)).toBe(8.5);
  });

  it('pushes new items later as an extra batch, reusing existing parents', async () => {
    const linear = new FakeLinear();
    const everhour = new FakeEverhour();
    const d = readyDraft();
    await push(d, { linear, everhour, config: testConfig(), save: () => {}, newUuid });
    d.items.push(makeItem({ id: 'e', day: '2026-10-05', project: 'Boxsy', hours: 1 }));
    d.totalHours = 9.5;
    syncParents(d);
    await push(d, { linear, everhour, config: testConfig(), save: () => {}, newUuid });
    expect(linear.issues.size).toBe(8);
    expect(everhour.posts).toBe(5);
  });
});

describe('push pushed flag', () => {
  it('clears pushed while an extra batch is unfinished and sets it again when done', async () => {
    const linear = new FakeLinear();
    const everhour = new FakeEverhour();
    const d = readyDraft();
    await push(d, { linear, everhour, config: testConfig(), save: () => {}, newUuid });
    expect(d.pushed).toBe(true);
    d.items.push(makeItem({ id: 'e', day: '2026-10-05', project: 'Boxsy', hours: 1 }));
    d.totalHours = 9.5;
    syncParents(d);
    everhour.autoSync = false;
    const saves: boolean[] = [];
    const r = await push(d, { linear, everhour, config: testConfig(), save: x => { saves.push(x.pushed); }, newUuid });
    expect(r.status).toBe('awaiting_sync');
    expect(saves[0]).toBe(false);
    expect(d.pushed).toBe(false);
    everhour.autoSync = true;
    await push(d, { linear, everhour, config: testConfig(), save: () => {}, newUuid });
    expect(d.pushed).toBe(true);
  });
});

describe('pool', () => {
  it('after a failure starts nothing new and waits for in-flight items before rejecting', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    await expect(pool([0, 1, 2, 3, 4, 5], 3, async i => {
      started.push(i);
      if (i === 0) { await sleep(5); throw new Error('boom'); }
      await sleep(60);
      finished.push(i);
    })).rejects.toThrow('boom');
    expect(finished.sort()).toEqual([1, 2]);
    expect(started.sort()).toEqual([0, 1, 2]);
  });
});
