import { describe, it, expect, vi } from 'vitest';
import { makeDraft, makeItem } from './helpers.js';
import { extractJsonArray, claudeWeights, heuristicWeight, runDistribute, runClaude, setSpawnForTests } from '../src/lib/weights.js';

const ev = { commits: {}, sessions: {} };
const zero = { commits: 0, insertions: 0, deletions: 0, files: 0, prompts: 0, sessions: 0, activeDays: 0 };

describe('weights', () => {
  it('extracts JSON arrays from fenced or chatty output', () => {
    expect(extractJsonArray('Sure!\n```json\n[{"id":"a"}]\n```')).toEqual([{ id: 'a' }]);
    expect(extractJsonArray('here: [1,2] done')).toEqual([1, 2]);
    expect(() => extractJsonArray('nothing')).toThrow(/No JSON array/);
  });

  it('clamps Claude weights and fails if any item is skipped', async () => {
    const run = async () => '[{"id":"a","weight":14,"reason":"big"},{"id":"b","weight":0.2,"reason":"tiny"}]';
    const w = await claudeWeights([{ id: 'a', title: '', description: '', evidence: zero }, { id: 'b', title: '', description: '', evidence: zero }], run);
    expect(w.get('a')).toEqual({ weight: 10, reason: 'big' });
    expect(w.get('b')!.weight).toBe(1);
    await expect(claudeWeights([{ id: 'c', title: '', description: '', evidence: zero }], run)).rejects.toThrow(/skipped 1/);
  });

  it('heuristic weights grow with evidence and default to 3 for manual items', () => {
    expect(heuristicWeight(zero)).toBe(3);
    expect(heuristicWeight({ ...zero, commits: 3, insertions: 800, prompts: 30 })).toBeGreaterThan(heuristicWeight({ ...zero, commits: 1, insertions: 10 }));
  });

  it('runDistribute weights unweighted items, falls back to heuristic on failure, and splits >3h items', async () => {
    const d = makeDraft({ totalHours: 8, items: [makeItem({ id: 'big', weight: null, title: 'Harness' }), makeItem({ id: 'small', weight: null })] });
    const run = vi.fn(async (prompt: string) => {
      if (prompt.includes('must become')) return '[{"id":"big","parts":[{"title":"Harness setup","description":"Set it up."},{"title":"Harness runs","description":"Ran it."},{"title":"Harness fixes","description":"Fixed it."}]}]';
      return '[{"id":"big","weight":10,"reason":"x"},{"id":"small","weight":1,"reason":"y"}]';
    });
    const out = await runDistribute(d, { reweight: false }, { run, evidence: ev });
    expect(out.weightsSource).toBe('claude');
    expect(out.items.map(i => i.title)).toEqual(['Harness setup', 'Harness runs', 'Harness fixes', 'Some task']);
    expect(out.items.every(i => i.hours! <= 3)).toBe(true);
    expect(out.items.reduce((s, i) => s + i.hours!, 0)).toBe(8);
    expect(out.parents.length).toBeGreaterThan(0);

    const failing = async () => { throw new Error('claude not found'); };
    const out2 = await runDistribute(makeDraft({ totalHours: 2, items: [makeItem({ weight: null })] }), { reweight: true }, { run: failing, evidence: ev });
    expect(out2.weightsSource).toBe('heuristic');
    expect(out2.items[0].hours).toBe(2);
  });

  it('runClaude disables our hooks and runs outside any repo (Review Focus #2)', async () => {
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    let seen: { args: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv } } | null = null;
    setSpawnForTests(((cmd: string, args: string[], opts: any) => {
      seen = { args, opts };
      const child: any = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => true;
      setImmediate(() => { child.stdout.end('[]'); child.emit('close', 0); });
      return child;
    }) as any);
    expect(await runClaude('hi')).toBe('[]');
    expect(seen!.args).toEqual(['-p', '--output-format', 'text']);
    expect(seen!.opts.env.TIMESHEET_DISABLE_HOOKS).toBe('1');
    expect(seen!.opts.cwd).toBe((await import('node:os')).tmpdir());
    setSpawnForTests(null);
  });

  it('runClaude rejects (no uncaught EPIPE) when claude is missing', async () => {
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    setSpawnForTests(((..._a: any[]) => {
      const child: any = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => true;
      setImmediate(() => {
        child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
      });
      return child;
    }) as any);
    try { await expect(runClaude('hi')).rejects.toThrow(/ENOENT/); } finally { setSpawnForTests(null); }
  });

  it('runDistribute falls back to mechanical split when Claude returns blank part titles', async () => {
    const d = makeDraft({ totalHours: 8, items: [makeItem({ id: 'big', weight: 5, title: 'Harness' })] });
    const run = async (prompt: string) => prompt.includes('must become')
      ? '[{"id":"big","parts":[{"title":"  ","description":"x"},{"title":"b","description":"y"},{"title":"c","description":"z"}]}]'
      : '[]';
    const out = await runDistribute(d, { reweight: false }, { run, evidence: ev });
    expect(out.items.length).toBeGreaterThan(1);
    expect(out.items.every(i => i.title.trim() !== '' && i.hours! <= 3)).toBe(true);
    expect(out.items.some(i => i.title === 'b')).toBe(false);
  });
});
