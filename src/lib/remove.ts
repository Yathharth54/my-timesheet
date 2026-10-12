import { parentKey } from './parents.js';
import type { LinearRemoveApi } from './linear.js';
import type { Everhour } from './everhour.js';
import type { Config, Draft } from './types.js';

export interface RemoveDeps {
  linear: LinearRemoveApi;
  everhour: Pick<Everhour, 'setTime'>;
  config: Pick<Config, 'everhour'>;
  save: (d: Draft) => Draft;
}
export interface RemoveResult {
  removed: string[];
  parents: string[];
  failed: { id: string; step: 'everhour' | 'linear' | 'parent'; error: string }[];
}

/**
 * Deletes pushed issues: clears their Everhour time for the day, trashes them in Linear, then trashes any parent
 * left with no issues. Saves after every step, so running it again after a failure picks up where it stopped.
 * A deleted item keeps its Linear ref as a tombstone, so /timesheet never drafts that work again.
 */
export async function removePushed(draft: Draft, ids: string[], deps: RemoveDeps): Promise<RemoveResult> {
  const out: RemoveResult = { removed: [], parents: [], failed: [] };
  const emptied = new Set<string>();
  for (const id of [...new Set(ids)]) {
    const item = draft.items.find(i => i.id === id);
    if (!item) { out.failed.push({ id, step: 'linear', error: `No issue with id ${id}.` }); continue; }
    if (item.deleted && item.linear) { // done on an earlier run; its parent may still need trashing
      out.removed.push(id);
      if (item.project) emptied.add(parentKey(item.day, item.project));
      continue;
    }
    if (item.deleted) { out.failed.push({ id, step: 'linear', error: `No issue with id ${id}.` }); continue; }
    if (!item.linear) { out.failed.push({ id, step: 'linear', error: `"${item.title}" isn't in Linear. Delete it in the review tab instead.` }); continue; }
    if (item.everhour?.logged) {
      try {
        await deps.everhour.setTime({ issueUuid: item.linear.uuid, userId: deps.config.everhour.userId, date: item.day, hours: 0 });
      } catch (e) { out.failed.push({ id, step: 'everhour', error: (e as Error).message }); continue; }
      item.everhour = null;
      deps.save(draft);
    }
    try { await deps.linear.deleteIssue(item.linear.uuid); } catch (e) { out.failed.push({ id, step: 'linear', error: (e as Error).message }); continue; }
    if (draft.totalHours != null && item.hours != null) draft.totalHours = Math.max(0, Math.round((draft.totalHours - item.hours) * 100) / 100) || null;
    item.deleted = true;
    item.hours = null;
    item.locked = false;
    deps.save(draft);
    out.removed.push(id);
    if (item.project) emptied.add(parentKey(item.day, item.project));
  }

  const used = new Set(draft.items.filter(i => !i.deleted && i.project).map(i => parentKey(i.day, i.project!)));
  for (const key of emptied) {
    if (used.has(key)) continue;
    const parent = draft.parents.find(p => p.key === key);
    if (!parent?.linear) continue;
    try { await deps.linear.deleteIssue(parent.linear.uuid); } catch (e) { out.failed.push({ id: key, step: 'parent', error: (e as Error).message }); continue; }
    out.parents.push(parent.linear.identifier ?? key);
    draft.parents = draft.parents.filter(p => p.key !== key);
    deps.save(draft);
  }
  return out;
}
