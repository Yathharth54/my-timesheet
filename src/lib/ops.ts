import { copyToDays, deleteItem, mergeItems, needsRemote, setHours } from './edit.js';
import { clashes, homeOf, members } from './groups.js';
import { weekDays, weekdayName } from './week.js';
import type { Draft, Item } from './types.js';

/** One change to a week. The review UI's bulk bar, Ask Claude and `timesheet edit` all send these. */
export type Op =
  | { op: 'set'; ids: string[]; project?: string; day?: string; title?: string; description?: string }
  | { op: 'hours'; id: string; hours: number }
  | { op: 'merge'; ids: string[] }
  | { op: 'delete'; ids: string[] }
  /** Logs the same issue on more days, as one Linear issue. Hours default to each source's own. */
  | { op: 'copy'; ids: string[]; days: string[]; hours?: number };

export type Example =
  | { kind: 'bucket'; title: string; description: string; from: string | null; to: string | null; at: string }
  | { kind: 'rewrite'; before: { title: string; description: string }; after: { title: string; description: string }; at: string };

export interface OpsResult {
  draft: Draft;
  /** One line per op, for the preview. */
  summary: string[];
  /** Pushed issues to delete. They need Linear and Everhour, so applyOps leaves them for removePushed. */
  remote: string[];
  /** Corrections to append to examples.jsonl, so later drafts learn from them. */
  examples: Example[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ref = (i: Item) => i.linear?.identifier ?? `"${i.title}"`;

/** The bucket flips and rewrites between two versions of one item. */
export function corrections(before: Item, after: Item, at = new Date().toISOString()): Example[] {
  const out: Example[] = [];
  if (before.project !== after.project) out.push({ kind: 'bucket', title: after.title, description: after.description, from: before.project, to: after.project, at });
  if (before.title !== after.title || before.description !== after.description) {
    out.push({ kind: 'rewrite', before: { title: before.title, description: before.description }, after: { title: after.title, description: after.description }, at });
  }
  return out;
}

function live(draft: Draft, id: string): Item {
  const item = draft.items.find(i => i.id === id && !i.deleted);
  if (!item) throw new Error(`No issue with id ${id}.`);
  return item;
}
function editable(draft: Draft, id: string): Item {
  const item = live(draft, id);
  if (item.linear) throw new Error(`${ref(item)} is already in Linear. Only delete works on it.`);
  return item;
}
const ids = (raw: unknown): string[] => {
  if (!Array.isArray(raw) || !raw.length) throw new Error('An op needs at least one id.');
  return [...new Set(raw.map(String))];
};

/** Applies ops in order to a copy of the draft. Throws on the first bad op, so nothing half-applies. */
export function applyOps(input: Draft, ops: Op[], projectNames: string[]): OpsResult {
  if (!Array.isArray(ops) || !ops.length) throw new Error('No changes to apply.');
  let draft = structuredClone(input);
  const summary: string[] = [];
  const remote: string[] = [];
  const examples: Example[] = [];
  const days = weekDays(draft.week);

  for (const op of ops) {
    switch (op?.op) {
      case 'set': {
        const list = ids(op.ids);
        const items = list.map(id => editable(draft, id));
        if (op.project !== undefined && !projectNames.includes(op.project)) throw new Error(`No project called ${op.project}.`);
        if (op.day !== undefined && !days.includes(op.day)) throw new Error(`${op.day} isn't in week ${draft.week}.`);
        if ((op.title !== undefined || op.description !== undefined) && list.length !== 1) throw new Error('A title or description can only change on one issue at a time.');
        if (op.title !== undefined && !String(op.title).trim()) throw new Error("A title can't be empty.");
        if (op.description !== undefined && !String(op.description).trim()) throw new Error("A description can't be empty.");
        if (op.project === undefined && op.day === undefined && op.title === undefined && op.description === undefined) throw new Error('A set op needs project, day, title or description.');
        const names = items.map(ref); // before any rename
        const shared = op.project !== undefined || op.title !== undefined || op.description !== undefined;
        for (const item of items) {
          // title, description and project belong to the Linear issue, so they change on every day of it
          const home = homeOf(draft, item);
          if (shared && home.linear) throw new Error(`${ref(home)} is already in Linear, so its title, description and project are fixed. Only the hours and day of its unprinted days can change.`);
          const group = shared ? members(draft, item) : [item];
          for (const it of group) {
            const before = structuredClone(it);
            if (op.project !== undefined) it.project = op.project;
            if (op.title !== undefined) it.title = String(op.title).trim();
            if (op.description !== undefined) it.description = String(op.description).trim();
            if (it.title !== before.title || it.description !== before.description) it.edited = true;
            if (!it.sameAs) examples.push(...corrections(before, it));
          }
          if (op.day !== undefined) item.day = op.day;
        }
        const clash = clashes(draft)[0];
        if (clash) throw new Error(`"${clash.item.title}" would be on ${weekdayName(clash.day)} twice. One Linear issue holds one entry per day.`);
        const what = [
          op.project !== undefined && `to ${op.project}`,
          op.day !== undefined && `to ${weekdayName(op.day)}`,
        ].filter(Boolean).join(' and ');
        if (what) summary.push(`Move ${list.length === 1 ? names[0] : plural(list.length, 'issue')} ${what}`);
        if (op.title !== undefined) summary.push(`Rename ${names[0]} to "${items[0].title}"`);
        if (op.description !== undefined) summary.push(`Rewrite what ${names[0]} says`);
        break;
      }
      case 'hours': {
        const item = editable(draft, String(op.id));
        draft = setHours(draft, item.id, Number(op.hours));
        summary.push(`Set ${ref(item)} to ${Number(op.hours).toFixed(1)}h`);
        break;
      }
      case 'merge': {
        const list = ids(op.ids);
        if (list.length < 2) throw new Error('Pick at least 2 issues to merge.');
        const first = editable(draft, list[0]);
        for (const id of list.slice(1)) editable(draft, id);
        draft = mergeItems(draft, list);
        summary.push(`Merge ${plural(list.length, 'issue')} into ${ref(first)} (${weekdayName(first.day)}, ${first.project ?? 'no project'})`);
        break;
      }
      case 'delete': {
        const list = ids(op.ids);
        const local: string[] = [];
        for (const id of list) {
          const item = live(draft, id);
          if (needsRemote(draft, item, list)) { if (!remote.includes(id)) remote.push(id); } else local.push(id);
        }
        for (const id of local) draft = deleteItem(draft, id);
        const pushed = list.length - local.length;
        summary.push(`Delete ${plural(list.length, 'issue')}${pushed ? ` (${pushed} from Linear and Everhour too)` : ''}`);
        break;
      }
      case 'copy': {
        const list = ids(op.ids);
        if (!Array.isArray(op.days) || !op.days.length) throw new Error('A copy op needs at least one day.');
        const hours = op.hours == null ? null : Number(op.hours);
        let copied = 0;
        for (const id of list) {
          const item = live(draft, id);
          const have = new Set(members(draft, item).map(m => m.day));
          const days = op.days.map(String).filter(d => !have.has(d));
          if (!days.length) {
            if (list.length === 1) throw new Error(`"${item.title}" is already on ${op.days.map(weekdayName).join(' and ')}.`);
            continue; // in a bulk copy, issues that already have every day are left alone
          }
          draft = copyToDays(draft, id, days, hours).draft;
          copied++;
          summary.push(`Log ${ref(item)} on ${days.map(weekdayName).join(', ')} too${hours != null ? ` at ${hours.toFixed(1)}h` : ''}`);
        }
        if (!copied) throw new Error('Every picked issue is already on those days.');
        break;
      }
      default: throw new Error(`Unknown op ${JSON.stringify((op as { op?: unknown })?.op)}.`);
    }
  }
  return { draft, summary, remote, examples };
}
