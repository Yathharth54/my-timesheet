import os from 'node:os';
import * as cp from 'node:child_process';
import { distribute, MAX_ITEM_HOURS } from './distribute.js';
import { mechanicalSplit, splitItem } from './edit.js';
import { statsFor, type EvidenceStats } from './evidence.js';
import { syncParents } from './parents.js';
import type { Draft, WeekEvidence } from './types.js';

export type ClaudeRunner = (prompt: string) => Promise<string>;
export interface WeightInput { id: string; title: string; description: string; evidence: EvidenceStats }

let spawnImpl: typeof cp.spawn = cp.spawn;
/** Test seam: pass null to restore the real spawn. */
export function setSpawnForTests(fn: typeof cp.spawn | null): void { spawnImpl = fn ?? cp.spawn; }

export const runClaude: ClaudeRunner = prompt =>
  new Promise((resolve, reject) => {
    const child = spawnImpl('claude', ['-p', '--output-format', 'text'], {
      cwd: os.tmpdir(),
      env: { ...process.env, TIMESHEET_DISABLE_HOOKS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude -p timed out after 180s')); }, 180_000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude -p exited ${code}: ${err.slice(0, 300)}`));
    });
    // A dead pipe (claude missing / exited early) emits EPIPE on stdin; 'error'/'close' already reject.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });

export function extractJsonArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('No JSON array in Claude output.');
  const v = JSON.parse(body.slice(start, end + 1));
  if (!Array.isArray(v)) throw new Error('Claude output was not a JSON array.');
  return v;
}

const weightsPrompt = (inputs: WeightInput[]): string => [
  'You are estimating relative human effort for timesheet items from one work week.',
  'For each item give an integer weight from 1 (trivial, minutes) to 10 (the most effortful item of the week) and a reason of at most 12 words.',
  'Judge real effort: reading, research and debugging count, not just lines changed. A 3-line config fix is 1-2; a new module with tests is 7-9.',
  'Evidence fields: commits, insertions, deletions, files touched, prompts (user turns in Claude), sessions, activeDays.',
  'Return ONLY a JSON array, one entry per item, same ids: [{"id":"...","weight":5,"reason":"..."}]',
  '',
  JSON.stringify(inputs, null, 1),
].join('\n');

export async function claudeWeights(inputs: WeightInput[], run: ClaudeRunner): Promise<Map<string, { weight: number; reason: string }>> {
  const out = new Map<string, { weight: number; reason: string }>();
  if (!inputs.length) return out;
  for (const e of extractJsonArray(await run(weightsPrompt(inputs))) as any[]) {
    if (typeof e?.id !== 'string') continue;
    const w = Math.round(Number(e.weight));
    if (!Number.isFinite(w)) continue;
    out.set(e.id, { weight: Math.min(10, Math.max(1, w)), reason: String(e.reason ?? '').slice(0, 120) });
  }
  const missing = inputs.filter(i => !out.has(i.id)).length;
  if (missing) throw new Error(`Claude skipped ${missing} items.`);
  return out;
}

export function heuristicWeight(s: EvidenceStats): number {
  if (s.commits === 0 && s.prompts === 0) return 3;
  const w = 1 + Math.log2(1 + s.insertions + s.deletions) / 1.5 + s.prompts / 6 + s.commits * 0.5;
  return Math.min(10, Math.max(1, Math.round(w)));
}

const splitsPrompt = (items: { id: string; title: string; description: string; parts: number }[]): string => [
  'Each item below took more than 3 hours and must become `parts` separate sub-issues, each covering a distinct piece of the same work.',
  'Titles are 2-3 words. Descriptions are 2-4 technical sentences. Never mention hours, durations or time.',
  'Return ONLY JSON: [{"id":"...","parts":[{"title":"...","description":"..."}]}] with exactly `parts` entries per item.',
  '',
  JSON.stringify(items, null, 1),
].join('\n');

export async function claudeSplits(
  items: { id: string; title: string; description: string; parts: number }[],
  run: ClaudeRunner,
): Promise<Map<string, { title: string; description: string }[]>> {
  const out = new Map<string, { title: string; description: string }[]>();
  if (!items.length) return out;
  for (const e of extractJsonArray(await run(splitsPrompt(items))) as any[]) {
    const want = items.find(i => i.id === e?.id);
    if (!want || !Array.isArray(e.parts) || e.parts.length !== want.parts) continue;
    if (!e.parts.every((p: any) => typeof p?.title === 'string' && p.title.trim() !== '' && typeof p?.description === 'string')) continue;
    out.set(want.id, e.parts.map((p: any) => ({ title: p.title, description: p.description })));
  }
  return out;
}

export async function runDistribute(
  input: Draft,
  opts: { reweight: boolean },
  deps: { run: ClaudeRunner; evidence: WeekEvidence },
): Promise<Draft> {
  let draft = structuredClone(input);
  const free = draft.items.filter(i => !i.deleted && !i.locked && !i.linear);
  const need = opts.reweight ? free : free.filter(i => i.weight == null);
  if (need.length) {
    const inputs: WeightInput[] = need.map(i => ({ id: i.id, title: i.title, description: i.description, evidence: statsFor(i, deps.evidence) }));
    try {
      const ws = await claudeWeights(inputs, deps.run);
      for (const i of need) { const w = ws.get(i.id)!; i.weight = w.weight; i.weightReason = w.reason; }
      draft.weightsSource = 'claude';
    } catch {
      for (const i of need) { i.weight = heuristicWeight(inputs.find(x => x.id === i.id)!.evidence); i.weightReason = 'heuristic: from evidence size'; }
      draft.weightsSource = 'heuristic';
    }
  }
  for (let round = 0; round < 3; round++) {
    const r = distribute(draft);
    draft = r.draft;
    if (!r.needsSplit.length) return syncParents(draft);
    const targets = r.needsSplit.map(id => draft.items.find(i => i.id === id)!).map(i => ({
      id: i.id, title: i.title, description: i.description, parts: Math.ceil(i.hours! / MAX_ITEM_HOURS),
    }));
    let splits = new Map<string, { title: string; description: string }[]>();
    try { splits = await claudeSplits(targets, deps.run); } catch { /* mechanical fallback below */ }
    for (const t of targets) draft = splitItem(draft, t.id, splits.get(t.id) ?? mechanicalSplit(t, t.parts));
  }
  return syncParents(distribute(draft).draft);
}
