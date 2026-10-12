import fs from 'node:fs';
import pc from 'picocolors';
import { appendLine, loadDraft, requireConfig, saveDraft } from '../../lib/store.js';
import { resolveWeek, weekDays } from '../../lib/week.js';
import { applyOps, type Op } from '../../lib/ops.js';
import { removePushed } from '../../lib/remove.js';
import { syncParents } from '../../lib/parents.js';
import { acquireWeekLock } from '../../lib/lock.js';
import { paths } from '../../lib/paths.js';
import { clientsFromSecrets } from './push.js';
import { ok } from '../out.js';

/** `timesheet show`: the week as JSON with issue ids, so Claude can write ops without reading draft files. */
export function show(weekArg?: string): void {
  const config = requireConfig();
  const week = resolveWeek(weekArg);
  const d = loadDraft(week);
  if (!d) throw new Error(`No draft for ${week}. Run /timesheet to draft it.`);
  console.log(JSON.stringify({
    week, days: weekDays(week), countedDays: d.days, totalHours: d.totalHours,
    projects: config.projects.map(({ name, kind }) => ({ name, kind })), internalProject: config.internalProject,
    issues: d.items.filter(i => !i.deleted).map(i => ({
      id: i.id, title: i.title, description: i.description, project: i.project, day: i.day, hours: i.hours, locked: i.locked,
      inLinear: i.linear ? (i.linear.identifier ?? true) : false, logged: !!i.everhour?.logged,
    })),
  }, null, 1));
}

function readOps(src: string | undefined): Op[] {
  if (!src) throw new Error('Pass the changes with --ops <file> (or --ops - to read stdin).');
  const raw = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new Error('--ops must be JSON: an array of ops, or {"ops": [...]}.'); }
  const ops = Array.isArray(v) ? v : (v as { ops?: unknown })?.ops;
  if (!Array.isArray(ops)) throw new Error('--ops must be JSON: an array of ops, or {"ops": [...]}.');
  return ops as Op[];
}

/** `timesheet edit`: applies ops to a week. Pushed issues are only deleted from Linear and Everhour with --remote. */
export async function edit(weekArg: string | undefined, opsSrc: string | undefined, remote: boolean): Promise<void> {
  const config = requireConfig();
  const week = resolveWeek(weekArg);
  const ops = readOps(opsSrc);
  let release: () => void;
  try { release = acquireWeekLock(week); } catch (e) { throw new Error(`${(e as Error).message} Try again when it's done.`); }
  try {
    const d = loadDraft(week);
    if (!d) throw new Error(`No draft for ${week}. Run /timesheet to draft it.`);
    const r = applyOps(d, ops, config.projects.map(p => p.name));
    for (const ex of r.examples) appendLine(paths.examples(), ex);
    const draft = saveDraft(syncParents(r.draft));
    for (const line of r.summary) ok(line);
    if (!r.remote.length) return;
    const list = r.remote.map(id => draft.items.find(i => i.id === id)!);
    if (!remote) {
      console.log(pc.yellow(`Not deleted yet, because ${list.length === 1 ? 'it is' : 'they are'} already in Linear and Everhour:`));
      for (const i of list) console.log(`   ${i.linear?.identifier ?? i.id}  ${i.title}${i.everhour?.logged ? `  (${(i.hours ?? 0).toFixed(1)}h on ${i.day})` : ''}`);
      console.log(pc.dim('Ask the user first. If they agree, run the same command with --remote.'));
      return;
    }
    const res = await removePushed(draft, r.remote, { ...clientsFromSecrets(), config, save: saveDraft });
    saveDraft(syncParents(draft));
    for (const id of res.removed) { const i = draft.items.find(x => x.id === id)!; ok(`Deleted ${i.linear?.identifier ?? id} from Linear (in its trash for 30 days) and cleared its Everhour time`); }
    for (const p of res.parents) ok(`Deleted the empty parent ${p}`);
    if (res.failed.length) {
      for (const f of res.failed) console.log(`${pc.red('✗')} ${f.id}: ${f.step} step failed: ${f.error}`);
      throw new Error(`${res.failed.length} of ${r.remote.length} not deleted. Running the same command again picks up where it stopped.`);
    }
  } finally { release(); }
}
