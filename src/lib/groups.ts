import type { Draft, Item, LinearRef } from './types.js';

/**
 * An issue logged on several days is one Linear issue. The draft keeps one item per day: the home item, which
 * owns the Linear issue and decides its parent, plus copies whose `sameAs` points at the home. Title,
 * description and project belong to the issue, so the copies always carry the home's. Hours, lock and day are
 * each day's own: every item logs its hours in Everhour on its own day.
 */
export const homeId = (item: Item): string => item.sameAs ?? item.id;

/** The home item, even when it's a deleted tombstone that still holds the Linear issue. */
export const homeOf = (draft: Draft, item: Item): Item => (item.sameAs ? draft.items.find(i => i.id === item.sameAs) ?? item : item);

/** Every live item on the same issue, this one included, sorted by day. */
export function members(draft: Draft, item: Item): Item[] {
  const h = homeId(item);
  return draft.items.filter(i => !i.deleted && (i.id === h || i.sameAs === h)).sort((a, b) => a.day.localeCompare(b.day));
}

export const inGroup = (draft: Draft, item: Item): boolean => !!item.sameAs || draft.items.some(i => i.sameAs === item.id && !i.deleted);

/** The Linear issue this item's hours land on: its own, or the home's once that is in Linear. */
export const sharedRef = (draft: Draft, item: Item): LinearRef | null => item.linear ?? (item.sameAs ? homeOf(draft, item).linear : null);

/**
 * Repairs groups after any change. A home deleted before it reached Linear hands over to its earliest copy, a
 * copy pointing at nothing stands alone, and every copy takes the home's title, description and project.
 */
export function normalizeGroups(draft: Draft): Draft {
  const byId = new Map(draft.items.map(i => [i.id, i]));
  for (const i of draft.items) if (i.sameAs && (!byId.has(i.sameAs) || i.sameAs === i.id)) i.sameAs = null;
  for (const home of draft.items) {
    if (home.sameAs || !home.deleted || home.linear) continue;
    const copies = draft.items.filter(i => i.sameAs === home.id && !i.deleted).sort((a, b) => a.day.localeCompare(b.day));
    if (!copies.length) continue;
    const [next] = copies;
    for (const i of draft.items) if (i.sameAs === home.id) i.sameAs = i === next ? null : next.id;
  }
  for (const i of draft.items) {
    if (!i.sameAs || i.deleted || i.linear?.created) continue;
    const home = byId.get(i.sameAs)!;
    i.title = home.title;
    i.description = home.description;
    i.project = home.project;
  }
  return draft;
}

/** A group with two items on one day would overwrite itself in Everhour, which holds one value per issue per day. */
export function clashes(draft: Draft): { item: Item; day: string }[] {
  const seen = new Map<string, Item>();
  const out: { item: Item; day: string }[] = [];
  for (const i of draft.items) {
    if (i.deleted) continue;
    const k = `${homeId(i)}|${i.day}`;
    if (seen.has(k)) out.push({ item: seen.get(k)!, day: i.day });
    else seen.set(k, i);
  }
  return out;
}
