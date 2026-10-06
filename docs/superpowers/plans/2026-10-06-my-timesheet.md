# my-timesheet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `my-timesheet`, an npm package that provides a Claude skill, hooks, a CLI and a local review UI. Together they turn a week of Claude Code sessions and git commits into Linear issues, with hours logged in Everhour.

**Architecture:**
- Hooks only write a small index file during the week.
- `/timesheet` condenses that index and the week's commits into a context file. Claude writes a proposal; code merges it into `draft.json`, the single source of truth.
- A loopback-only Node server and a vanilla-JS terminal-style page let the user edit the draft, enter the weekly total and distribute hours. Weights come from `claude -p`; the arithmetic is plain code.
- The push talks to Linear GraphQL and Everhour REST directly. It writes state per item as it goes, so it can resume after a failure.

**Tech Stack:** Node ≥ 20, TypeScript (ESM, `NodeNext`), vitest, `@clack/prompts`, `picocolors`, `node:http`, and a plain HTML/CSS/JS front end with no build step.

**Spec:** `docs/superpowers/specs/2026-10-06-my-timesheet-design.md`

## Global Constraints

- Package name `my-timesheet`; binary `timesheet`; Claude command `/timesheet`; skill folder `~/.claude/skills/timesheet/`.
- Node `>=20`, `"type": "module"`, TypeScript `strict`. The only runtime dependencies are `@clack/prompts` and `picocolors`.
- The data dir is `~/.timesheet/`, overridable with `TIMESHEET_HOME`. The Claude dir is `~/.claude/`, overridable with `TIMESHEET_CLAUDE_DIR`. Tests always set both to temp dirs.
- Hooks never call a model, never copy transcripts, **always exit 0**, and do nothing when `TIMESHEET_DISABLE_HOOKS=1`.
- Hooks write nothing for repos that are unclassified, personal or ignored.
- Hours come in 0.5h units. No sub-issue is over 3h. Item hours sum **exactly** to the user's total.
- No hours or durations in any issue title or description.
- Everhour task ID = `li:{Linear issue UUID}`; Everhour project ID = `li:{Linear project UUID}`. Always match projects by UUID, never by name.
- Everhour's sync API does not import new issues, so the push waits for a manual Sync click.
- Time is logged with `POST https://api.everhour.com/time` `{task, user, date, time}`, which upserts one record per `(user, date, task)`.
- Linear issues are created with a client-generated UUID (`IssueCreateInput.id`), saved before the request is sent. That's what makes retries safe.
- The server binds `127.0.0.1` (default port `4747`), rejects any other `Host` header, and never sends API keys to the browser.
- Secrets live in the macOS Keychain (`security`), or in a `0600` file elsewhere or when `TIMESHEET_SECRETS_FILE` is set. Secrets never appear in prompts, logs or `draft.json`.
- CLI output follows the uv style: one line per step with a dim timing, braille spinner, `+` lines for things added, colour only on ✓/✗, no emoji, and a single summary line at the end.
- **Git:** commit messages never include `Co-Authored-By` or any Claude/AI attribution.
- Tests run with `TZ=UTC` unless a test sets `process.env.TZ` itself.

## Review Focus

1. **Paths with spaces, or a cwd that no longer exists.** Hooks must exit 0 and write nothing. The author's own project folder is `timesheet skill`, which has a space. Pinned in Task 3.
2. **The review server's own `claude -p` call triggering our Stop hook** and logging fake sessions. The server spawns it with `TIMESHEET_DISABLE_HOOKS=1` and `cwd = os.tmpdir()`. Pinned in Tasks 3 and 9.
3. **Malformed transcript lines, timestamps outside the week, and turns near midnight in a non-UTC timezone.** Bad lines are skipped, and turns are assigned to the *local* date. Pinned in Task 4.
4. **Bad totals:** not a multiple of 0.5h, less than 0.5h × items, or locked hours above the total. Each gives a clear error and nothing is saved. Pinned in Tasks 8 and 15.
5. **A stale browser draft** (`/timesheet` re-ingested while the page was open). It gets a 409, the page re-applies its unsaved field edits onto the fresh draft, and pushed items can't be changed through PUT. Pinned in Task 15.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, README.md
scripts/copy-assets.mjs            copy src/server/public → dist/server/public after tsc
skill/SKILL.md                     drafting procedure + writing rules (installed to ~/.claude/skills/timesheet/)
skill/commands/timesheet.md        /timesheet command (installed to ~/.claude/commands/)
src/lib/types.ts                   every shared type
src/lib/paths.ts                   data-dir paths
src/lib/week.ts                    ISO week + local-date helpers
src/lib/store.ts                   JSON/JSONL IO, config/repos/draft load+save
src/lib/repo.ts                    repo root, remote parsing, work/personal classification
src/lib/condense.ts                transcript → Digest
src/lib/evidence.ts                git commits + per-item evidence stats
src/lib/merge.ts                   proposal → draft merge (edits, tombstones, pushed)
src/lib/parents.ts                 one parent per day×project
src/lib/draftflow.ts               prepare (context.json/evidence.json) + ingest (proposal.json)
src/lib/distribute.ts              allocate / distribute / balanceDays (pure)
src/lib/edit.ts                    setHours / splitItem / mergeItems / addManualItem / deleteItem (pure)
src/lib/validate.ts                blocking + soft warnings
src/lib/weights.ts                 claude -p runner, weights, splits, runDistribute
src/lib/http.ts                    fetch with retry/backoff
src/lib/linear.ts                  Linear GraphQL client
src/lib/everhour.ts                Everhour REST client
src/lib/push.ts                    resumable push orchestrator
src/lib/keychain.ts                secret storage
src/lib/install.ts                 hooks + skill-file install/uninstall
src/hooks/common.ts                stdin, error log, isMain, disable flag
src/hooks/session-start.ts         SessionStart hook
src/hooks/stop.ts                  Stop hook
src/cli/out.ts                     uv-style output helpers
src/cli/index.ts                   argument parsing + dispatch
src/cli/commands/*.ts              init, repo, prepare, ingest, status, review, push, doctor, uninstall
src/server/server.ts               loopback HTTP API + static files
src/server/public/index.html, app.js, styles.css   the review UI
tests/*.test.ts, tests/helpers.ts, tests/fakes.ts
```

---

### Task 1: Scaffold, shared types, paths, weeks, store

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/copy-assets.mjs`
- Modify: `.gitignore`
- Create: `src/lib/types.ts`, `src/lib/paths.ts`, `src/lib/week.ts`, `src/lib/store.ts`
- Test: `tests/helpers.ts`, `tests/week.test.ts`, `tests/store.test.ts`

**Interfaces:**
- Produces: every type in `types.ts` (used by all tasks).
- Produces: `paths.*()`.
- Produces from `week.ts`: `localDate(d: Date): string`, `isoWeek(d: Date): string`, `weekDays(week): string[]` (Mon..Sun), `shiftWeek(week, delta)`, `weekOfDate(date)`, `weekdayName(date)`, `weekWindow(week): {from: Date; to: Date}`, `resolveWeek(arg?: string, now?: Date): string`, `dayDistance(a, b): number`.
- Produces from `store.ts`: `readJson`, `writeJsonAtomic`, `appendLine`, `readJsonl`, `loadConfig(): Config|null`, `requireConfig(): Config`, `saveConfig`, `loadRepos(): Repos`, `saveRepos`, `emptyDraft(week): Draft`, `loadDraft(week): Draft|null`, `saveDraft(d: Draft): Draft` (bumps `rev` **in place** and returns the same object), `listWeeks(): string[]`.

- [ ] **Step 1: Initialise the package and install dependencies**

```bash
cd "/Users/yathsmk/Personal Projects/timesheet skill"
npm init -y >/dev/null
npm i @clack/prompts picocolors
npm i -D typescript vitest @types/node
```

- [ ] **Step 2: Write `package.json` (keep the installed dependency versions npm wrote)**

Edit `package.json` so these fields are set. Leave the `dependencies` and `devDependencies` blocks as npm wrote them.

```json
{
  "name": "my-timesheet",
  "version": "0.1.0",
  "description": "Turn a week of Claude Code sessions and commits into Linear issues with Everhour time",
  "type": "module",
  "bin": { "timesheet": "dist/cli/index.js" },
  "files": ["dist", "skill"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json && node scripts/copy-assets.mjs",
    "test": "TZ=UTC vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "license": "UNLICENSED",
  "private": false
}
```

- [ ] **Step 3: Write `tsconfig.json`, `vitest.config.ts`, `scripts/copy-assets.mjs`, `.gitignore`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": false
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], testTimeout: 20000, pool: 'forks' } });
```

`scripts/copy-assets.mjs`:
```js
import fs from 'node:fs';
fs.cpSync('src/server/public', 'dist/server/public', { recursive: true });
```

`.gitignore` (replace contents):
```
.DS_Store
node_modules/
dist/
```

- [ ] **Step 4: Write `src/lib/types.ts`**

```ts
export type RepoClass = 'work' | 'personal' | 'ignore';
export interface RepoEntry { class: RepoClass; project?: string; name?: string }
/** key: absolute repo root (or folder path when not a git repo) */
export type Repos = Record<string, RepoEntry>;

export type ProjectKind = 'billable' | 'internal';
export interface ProjectConfig { id: string; name: string; teamId: string; kind: ProjectKind; stateId: string; labelIds: string[] }

export interface Config {
  version: 1;
  linear: { assigneeId: string; assigneeEmail: string };
  everhour: { userId: number };
  projects: ProjectConfig[];
  internalProject: string;
  workOrgs: string[];
  gitEmails: string[];
  nudge: boolean;
  port: number;
}

export interface LogEntry { t: string; session: string; root: string; repo: string; project: string | null; transcript: string }

export interface Evidence { commits: string[]; sessions: string[]; manual: boolean }
export interface LinearRef { uuid: string; identifier: string | null; url: string | null; created: boolean }

export interface Item {
  id: string;
  title: string;
  description: string;
  project: string | null;
  bucketReason: string;
  day: string;
  evidence: Evidence;
  weight: number | null;
  weightReason: string | null;
  hours: number | null;
  locked: boolean;
  edited: boolean;
  deleted: boolean;
  linear: LinearRef | null;
  everhour: { logged: boolean } | null;
}

export interface Parent { key: string; title: string; description: string; edited: boolean; linear: LinearRef | null }

export interface Draft {
  week: string;
  rev: number;
  totalHours: number | null;
  days: string[];
  weightsSource: 'claude' | 'heuristic' | null;
  pushed: boolean;
  items: Item[];
  parents: Parent[];
}

export interface Warning { level: 'block' | 'warn'; code: string; message: string; itemId?: string }

export interface DayActivity { turns: number; first: string; last: string }
export interface Digest {
  session: string; transcript: string; missing: boolean;
  prompts: string[]; filesEdited: string[]; commands: string[]; replies: string[];
  days: Record<string, DayActivity>;
}

export interface Commit {
  sha: string; root: string; repo: string; at: string; day: string;
  subject: string; files: string[]; insertions: number; deletions: number;
}

export interface SessionEvidence { repo: string; project: string | null; prompts: number; days: Record<string, DayActivity> }
export interface WeekEvidence { commits: Record<string, Commit>; sessions: Record<string, SessionEvidence> }

export interface ProposedItem {
  id?: string; title: string; description: string; project: string | null; bucketReason: string; day: string;
  evidence: { commits: string[]; sessions: string[] };
}
export interface ProposedParent { key: string; title: string; description: string }
export interface Proposal { items: ProposedItem[]; parents?: ProposedParent[] }
```

- [ ] **Step 5: Write `src/lib/paths.ts`**

```ts
import os from 'node:os';
import path from 'node:path';

export function home(): string {
  return process.env.TIMESHEET_HOME ?? path.join(os.homedir(), '.timesheet');
}

export const paths = {
  config: () => path.join(home(), 'config.json'),
  repos: () => path.join(home(), 'repos.json'),
  examples: () => path.join(home(), 'examples.jsonl'),
  hookErrors: () => path.join(home(), 'hook-errors.log'),
  secrets: () => process.env.TIMESHEET_SECRETS_FILE ?? path.join(home(), 'secrets.json'),
  log: (week: string) => path.join(home(), 'log', `${week}.jsonl`),
  weeksDir: () => path.join(home(), 'weeks'),
  weekDir: (week: string) => path.join(home(), 'weeks', week),
  draft: (week: string) => path.join(home(), 'weeks', week, 'draft.json'),
  context: (week: string) => path.join(home(), 'weeks', week, 'context.json'),
  proposal: (week: string) => path.join(home(), 'weeks', week, 'proposal.json'),
  evidence: (week: string) => path.join(home(), 'weeks', week, 'evidence.json'),
};
```

- [ ] **Step 6: Write the failing week tests in `tests/week.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { isoWeek, weekDays, shiftWeek, weekdayName, resolveWeek, weekOfDate, localDate } from '../src/lib/week.js';

describe('week helpers', () => {
  it('computes ISO weeks', () => {
    expect(isoWeek(new Date(2026, 9, 6))).toBe('2026-W41');
    expect(isoWeek(new Date(2026, 8, 28))).toBe('2026-W40');
    expect(isoWeek(new Date(2027, 0, 1))).toBe('2026-W53');
    expect(isoWeek(new Date(2025, 11, 29))).toBe('2026-W01');
  });
  it('lists Monday..Sunday', () => {
    expect(weekDays('2026-W41')).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  });
  it('shifts weeks across years', () => {
    expect(shiftWeek('2026-W41', -1)).toBe('2026-W40');
    expect(shiftWeek('2026-W53', 1)).toBe('2027-W01');
  });
  it('names weekdays and resolves arguments', () => {
    expect(weekdayName('2026-10-05')).toBe('Monday');
    const now = new Date(2026, 9, 6, 10);
    expect(resolveWeek(undefined, now)).toBe('2026-W41');
    expect(resolveWeek('last', now)).toBe('2026-W40');
    expect(resolveWeek('2026-W30', now)).toBe('2026-W30');
    expect(() => resolveWeek('yesterday', now)).toThrow(/Unrecognised week/);
    expect(weekOfDate('2026-10-11')).toBe('2026-W41');
    expect(localDate(new Date(2026, 0, 2, 23, 59))).toBe('2026-01-02');
  });
});
```

- [ ] **Step 7: Run the tests and confirm they fail**

Run: `npm test -- tests/week.test.ts`
Expected: FAIL. The module `../src/lib/week.js` can't be found.

- [ ] **Step 8: Write `src/lib/week.ts`**

```ts
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const parse = (date: string): Date => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export function localDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dow + 3);
  const year = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function weekDays(week: string): string[] {
  const [y, w] = week.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (w - 1) * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

export const weekOfDate = (date: string): string => isoWeek(parse(date));

export function shiftWeek(week: string, delta: number): string {
  const d = parse(weekDays(week)[0]);
  d.setDate(d.getDate() + 7 * delta);
  return isoWeek(d);
}

export const weekdayName = (date: string): string => DAY_NAMES[parse(date).getDay()];

export function weekWindow(week: string): { from: Date; to: Date } {
  const from = parse(weekDays(week)[0]);
  const to = new Date(from);
  to.setDate(to.getDate() + 7);
  return { from, to };
}

export function resolveWeek(arg: string | undefined, now: Date = new Date()): string {
  if (!arg || arg === 'this') return isoWeek(now);
  if (arg === 'last') return shiftWeek(isoWeek(now), -1);
  if (/^\d{4}-W\d{2}$/.test(arg)) return arg;
  throw new Error(`Unrecognised week "${arg}". Use this, last or YYYY-Www.`);
}

export const dayDistance = (a: string, b: string): number =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
```

- [ ] **Step 9: Run the week tests and confirm they pass**

Run: `npm test -- tests/week.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 10: Write `tests/helpers.ts` and the failing store tests**

`tests/helpers.ts`:
```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, Draft, Item } from '../src/lib/types.js';

export function tmpDir(prefix = 'ts-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function tmpHome(): string {
  const dir = tmpDir('ts-home-');
  process.env.TIMESHEET_HOME = dir;
  process.env.TIMESHEET_CLAUDE_DIR = path.join(dir, 'claude');
  process.env.TIMESHEET_SECRETS_FILE = path.join(dir, 'secrets.json');
  return dir;
}

export function testConfig(o: Partial<Config> = {}): Config {
  return {
    version: 1,
    linear: { assigneeId: 'user-1', assigneeEmail: 'me@x.ai' },
    everhour: { userId: 42 },
    projects: [
      { id: 'proj-box', name: 'Boxsy', teamId: 'team-box', kind: 'billable', stateId: 'state-box', labelIds: [] },
      { id: 'proj-int', name: 'Dev - Internal', teamId: 'team-the', kind: 'internal', stateId: 'state-the', labelIds: [] },
    ],
    internalProject: 'Dev - Internal',
    workOrgs: ['TheAgenticAI'],
    gitEmails: ['me@x.ai'],
    nudge: false,
    port: 4747,
    ...o,
  };
}

let seq = 0;
export function makeItem(o: Partial<Item> = {}): Item {
  return {
    id: o.id ?? `i${++seq}`,
    title: 'Some task',
    description: 'Did a technical thing. It worked.',
    project: 'Boxsy',
    bucketReason: 'client feature',
    day: '2026-10-05',
    evidence: { commits: [], sessions: [], manual: false },
    weight: 1,
    weightReason: null,
    hours: null,
    locked: false,
    edited: false,
    deleted: false,
    linear: null,
    everhour: null,
    ...o,
  };
}

export function makeDraft(o: Partial<Draft> = {}): Draft {
  return {
    week: '2026-W41',
    rev: 1,
    totalHours: null,
    days: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'],
    weightsSource: null,
    pushed: false,
    items: [],
    parents: [],
    ...o,
  };
}
```

`tests/store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { tmpHome, testConfig } from './helpers.js';
import { paths } from '../src/lib/paths.js';
import { appendLine, readJsonl, loadConfig, saveConfig, emptyDraft, saveDraft, loadDraft, listWeeks, requireConfig } from '../src/lib/store.js';

describe('store', () => {
  beforeEach(() => { tmpHome(); });

  it('returns null config before init and errors clearly when required', () => {
    expect(loadConfig()).toBeNull();
    expect(() => requireConfig()).toThrow(/timesheet init/);
    saveConfig(testConfig());
    expect(loadConfig()?.workOrgs).toEqual(['TheAgenticAI']);
  });

  it('skips corrupt JSONL lines', () => {
    const f = paths.log('2026-W41');
    appendLine(f, { a: 1 });
    fs.appendFileSync(f, '{broken\n');
    appendLine(f, { a: 2 });
    expect(readJsonl<{ a: number }>(f).map(x => x.a)).toEqual([1, 2]);
  });

  it('saveDraft bumps rev in place and lists weeks', () => {
    const d = emptyDraft('2026-W41');
    expect(d.days).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    const same = saveDraft(d);
    expect(same).toBe(d);
    expect(d.rev).toBe(1);
    expect(loadDraft('2026-W41')?.rev).toBe(1);
    expect(listWeeks()).toEqual(['2026-W41']);
  });

  it('throws a clear error on corrupt JSON', () => {
    fs.mkdirSync(paths.weekDir('2026-W41'), { recursive: true });
    fs.writeFileSync(paths.draft('2026-W41'), '{nope');
    expect(() => loadDraft('2026-W41')).toThrow(/Could not read/);
  });
});
```

- [ ] **Step 11: Run the store tests and confirm they fail**

Run: `npm test -- tests/store.test.ts`
Expected: FAIL. The module `../src/lib/store.js` can't be found.

- [ ] **Step 12: Write `src/lib/store.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import { weekDays } from './week.js';
import type { Config, Draft, Repos } from './types.js';

export function readJson<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`Could not read ${file}: ${(e as Error).message}`);
  }
}

export function writeJsonAtomic(file: string, data: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
}

export function appendLine(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

export function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip corrupt line */ }
  }
  return out;
}

export const loadConfig = (): Config | null => readJson<Config | null>(paths.config(), null);
export function requireConfig(): Config {
  const c = loadConfig();
  if (!c) throw new Error('my-timesheet is not set up yet. Run: timesheet init');
  return c;
}
export const saveConfig = (c: Config): void => writeJsonAtomic(paths.config(), c);
export const loadRepos = (): Repos => readJson<Repos>(paths.repos(), {});
export const saveRepos = (r: Repos): void => writeJsonAtomic(paths.repos(), r);

export function emptyDraft(week: string): Draft {
  return { week, rev: 0, totalHours: null, days: weekDays(week).slice(0, 5), weightsSource: null, pushed: false, items: [], parents: [] };
}
export const loadDraft = (week: string): Draft | null => readJson<Draft | null>(paths.draft(week), null);
export function saveDraft(d: Draft): Draft {
  d.rev += 1;
  writeJsonAtomic(paths.draft(d.week), d);
  return d;
}

export function listWeeks(): string[] {
  try {
    return fs.readdirSync(paths.weeksDir()).filter(w => /^\d{4}-W\d{2}$/.test(w)).sort().reverse();
  } catch {
    return [];
  }
}
```

- [ ] **Step 13: Run all tests and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS (8 tests). The typecheck exits 0.

- [ ] **Step 14: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts scripts .gitignore src tests
git commit -m "feat: scaffold package with shared types, week helpers and JSON store"
```

---

### Task 2: Repo classification (`repo.ts`)

**Files:**
- Create: `src/lib/repo.ts`
- Test: `tests/repo.test.ts`

**Interfaces:**
- Consumes: `Repos`, `RepoEntry` (Task 1); `loadRepos`, `saveRepos` (Task 1).
- Produces:
  - `parseRemote(url: string): Remote | null`, where `Remote = {host, owner, name}`.
  - `interface GitProbe { root(cwd: string): string; remoteUrls(root: string): string[] }` and `realGit: GitProbe`.
  - `type Classification = {kind:'saved'; root; entry} | {kind:'org'; root; entry} | {kind:'unknown'; root; slug: string|null}`.
  - `classify(cwd, repos, workOrgs, git = realGit): Classification`.
  - `setRepo(root: string, entry: RepoEntry): void`.
  - `slugFor(root: string, git = realGit): string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpHome } from './helpers.js';
import { parseRemote, classify, realGit, setRepo, type GitProbe } from '../src/lib/repo.js';
import { loadRepos } from '../src/lib/store.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

describe('parseRemote', () => {
  it.each([
    ['https://github.com/TheAgenticAI/boxsy-v2.0.git', 'TheAgenticAI', 'boxsy-v2.0'],
    ['git@github.com:TheAgenticAI/boxsy-v2.0.git', 'TheAgenticAI', 'boxsy-v2.0'],
    ['ssh://git@github.com/theagenticai/agentic-memory', 'theagenticai', 'agentic-memory'],
    ['https://github.com/Yathharth54/my-timesheet/', 'Yathharth54', 'my-timesheet'],
  ])('%s', (url, owner, name) => {
    expect(parseRemote(url)).toMatchObject({ host: 'github.com', owner, name });
  });
  it('returns null for junk', () => { expect(parseRemote('not a url')).toBeNull(); });
});

describe('classify', () => {
  const fake = (root: string, urls: string[]): GitProbe => ({ root: () => root, remoteUrls: () => urls });

  it('uses a saved answer first', () => {
    const c = classify('/r/sub', { '/r': { class: 'personal' } }, ['TheAgenticAI'], fake('/r', ['git@github.com:TheAgenticAI/x.git']));
    expect(c).toEqual({ kind: 'saved', root: '/r', entry: { class: 'personal' } });
  });
  it('matches work orgs case-insensitively on any remote (fork with upstream)', () => {
    const c = classify('/r', {}, ['TheAgenticAI'], fake('/r', ['git@github.com:me/x.git', 'https://github.com/theagenticai/x.git']));
    expect(c).toEqual({ kind: 'org', root: '/r', entry: { class: 'work', name: 'theagenticai/x' } });
  });
  it('is unknown otherwise and reports a slug', () => {
    expect(classify('/r', {}, ['TheAgenticAI'], fake('/r', ['git@github.com:me/side.git']))).toEqual({ kind: 'unknown', root: '/r', slug: 'me/side' });
    expect(classify('/r', {}, ['TheAgenticAI'], fake('/r', []))).toEqual({ kind: 'unknown', root: '/r', slug: null });
  });
});

describe('realGit', () => {
  beforeEach(() => { tmpHome(); });

  it('resolves subfolders and worktrees to the main repo root, folders with spaces too', () => {
    const base = tmpDir();
    const repo = path.join(base, 'timesheet skill');
    fs.mkdirSync(path.join(repo, 'a', 'b'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:TheAgenticAI/demo.git');
    const wt = path.join(base, 'wt');
    git(repo, 'worktree', 'add', '-q', wt);
    expect(realGit.root(path.join(repo, 'a', 'b'))).toBe(repo);
    expect(realGit.root(wt)).toBe(repo);
    expect(realGit.remoteUrls(repo)).toEqual(['git@github.com:TheAgenticAI/demo.git']);
  });

  it('falls back to the folder path when not a git repo or the folder is gone', () => {
    const dir = tmpDir();
    expect(realGit.root(dir)).toBe(dir);
    expect(realGit.root(path.join(dir, 'missing folder'))).toBe(path.join(dir, 'missing folder'));
    expect(realGit.remoteUrls(path.join(dir, 'missing folder'))).toEqual([]);
  });

  it('setRepo persists entries', () => {
    setRepo('/r', { class: 'work', project: 'Boxsy' });
    expect(loadRepos()['/r']).toEqual({ class: 'work', project: 'Boxsy' });
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/repo.test.ts`
Expected: FAIL. The module `../src/lib/repo.js` can't be found.

- [ ] **Step 3: Write `src/lib/repo.ts`**

```ts
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRepos, saveRepos } from './store.js';
import type { RepoEntry, Repos } from './types.js';

export interface Remote { host: string; owner: string; name: string }

export function parseRemote(url: string): Remote | null {
  const m = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? { host: m[1], owner: m[2], name: m[3] } : null;
}

export interface GitProbe { root(cwd: string): string; remoteUrls(root: string): string[] }

const run = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();

export const realGit: GitProbe = {
  root(cwd) {
    try {
      const common = run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (path.basename(common) === '.git') return path.dirname(common);
      return run(cwd, ['rev-parse', '--show-toplevel']);
    } catch {
      return path.resolve(cwd);
    }
  },
  remoteUrls(root) {
    try {
      const lines = run(root, ['remote', '-v']).split('\n').filter(Boolean);
      const byName = new Map<string, string>();
      for (const l of lines) {
        const [name, url] = l.split(/\s+/);
        if (name && url && !byName.has(name)) byName.set(name, url);
      }
      const names = [...byName.keys()].sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : a.localeCompare(b)));
      return names.map(n => byName.get(n)!);
    } catch {
      return [];
    }
  },
};

export type Classification =
  | { kind: 'saved'; root: string; entry: RepoEntry }
  | { kind: 'org'; root: string; entry: RepoEntry }
  | { kind: 'unknown'; root: string; slug: string | null };

export function classify(cwd: string, repos: Repos, workOrgs: string[], git: GitProbe = realGit): Classification {
  const root = git.root(cwd);
  const saved = repos[root];
  if (saved) return { kind: 'saved', root, entry: saved };
  const remotes = git.remoteUrls(root).map(parseRemote).filter((r): r is Remote => r !== null);
  const orgs = new Set(workOrgs.map(o => o.toLowerCase()));
  const hit = remotes.find(r => orgs.has(r.owner.toLowerCase()));
  if (hit) return { kind: 'org', root, entry: { class: 'work', name: `${hit.owner}/${hit.name}` } };
  return { kind: 'unknown', root, slug: remotes[0] ? `${remotes[0].owner}/${remotes[0].name}` : null };
}

export function slugFor(root: string, git: GitProbe = realGit): string | null {
  const r = git.remoteUrls(root).map(parseRemote).find(Boolean);
  return r ? `${r.owner}/${r.name}` : null;
}

export function setRepo(root: string, entry: RepoEntry): void {
  const repos = loadRepos();
  repos[root] = entry;
  saveRepos(repos);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- tests/repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/repo.ts tests/repo.test.ts
git commit -m "feat: classify repos as work by GitHub org with saved answers"
```

---

### Task 3: Hooks (SessionStart + Stop)

**Files:**
- Create: `src/hooks/common.ts`, `src/hooks/session-start.ts`, `src/hooks/stop.ts`
- Test: `tests/hooks.test.ts`, `tests/hooks.process.test.ts`

**Interfaces:**
- Consumes: `classify`, `setRepo`, `GitProbe`, `realGit` (Task 2); `loadConfig`, `loadRepos`, `appendLine`, `loadDraft` (Task 1); `paths` (Task 1); `isoWeek`, `shiftWeek` (Task 1).
- Produces:
  - `sessionStartContext(input: {cwd: string}, deps: {now: Date; git: GitProbe}): string | null`
  - `recordTurn(input: {cwd: string; session_id: string; transcript_path: string}, deps: {now: Date; git: GitProbe}): boolean`
  - `hooksDisabled(): boolean`, which reads `TIMESHEET_DISABLE_HOOKS`.
  - Compiled entry points `dist/hooks/session-start.js` and `dist/hooks/stop.js`. Both read hook JSON from stdin and always exit 0.

- [ ] **Step 1: Write the failing in-process tests in `tests/hooks.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { tmpHome, testConfig } from './helpers.js';
import { saveConfig, loadRepos, readJsonl, saveRepos, saveDraft, emptyDraft, appendLine } from '../src/lib/store.js';
import { paths } from '../src/lib/paths.js';
import type { GitProbe } from '../src/lib/repo.js';
import { sessionStartContext } from '../src/hooks/session-start.js';
import { recordTurn } from '../src/hooks/stop.js';

const now = new Date('2026-10-06T10:00:00Z');
const probe = (root: string, urls: string[]): GitProbe => ({ root: () => root, remoteUrls: () => urls });
const turn = { session_id: 's1', transcript_path: '/t/s1.jsonl' };

describe('hooks', () => {
  beforeEach(() => { tmpHome(); delete process.env.TIMESHEET_DISABLE_HOOKS; });

  it('does nothing before init', () => {
    expect(sessionStartContext({ cwd: '/r' }, { now, git: probe('/r', []) })).toBeNull();
    expect(recordTurn({ cwd: '/r', ...turn }, { now, git: probe('/r', []) })).toBe(false);
  });

  it('asks once for unknown folders and logs nothing there', () => {
    saveConfig(testConfig());
    const ctx = sessionStartContext({ cwd: '/side' }, { now, git: probe('/side', ['git@github.com:me/side.git']) });
    expect(ctx).toMatch(/Work, Personal, or Ignore/);
    expect(ctx).toContain('timesheet repo <work|personal|ignore> --path "/side"');
    expect(recordTurn({ cwd: '/side', ...turn }, { now, git: probe('/side', []) })).toBe(false);
    expect(fs.existsSync(paths.log('2026-W41'))).toBe(false);
  });

  it('saves org repos as work, asks for the project, and logs turns', () => {
    saveConfig(testConfig());
    const g = probe('/w', ['git@github.com:TheAgenticAI/boxsy.git']);
    const ctx = sessionStartContext({ cwd: '/w' }, { now, git: g });
    expect(loadRepos()['/w']).toEqual({ class: 'work', name: 'TheAgenticAI/boxsy' });
    expect(ctx).toMatch(/which project it bills to \(Boxsy\)/);
    expect(recordTurn({ cwd: '/w', ...turn }, { now, git: g })).toBe(true);
    const [line] = readJsonl<any>(paths.log('2026-W41'));
    expect(line).toEqual({ t: now.toISOString(), session: 's1', root: '/w', repo: 'TheAgenticAI/boxsy', project: null, transcript: '/t/s1.jsonl' });
  });

  it('stays silent for classified repos and never logs personal ones', () => {
    saveConfig(testConfig());
    saveRepos({ '/w': { class: 'work', project: 'Boxsy', name: 'TheAgenticAI/boxsy' }, '/p': { class: 'personal' } });
    expect(sessionStartContext({ cwd: '/w' }, { now, git: probe('/w', []) })).toBeNull();
    expect(recordTurn({ cwd: '/p', ...turn }, { now, git: probe('/p', []) })).toBe(false);
  });

  it('honours TIMESHEET_DISABLE_HOOKS', () => {
    saveConfig(testConfig());
    saveRepos({ '/w': { class: 'work', project: 'Boxsy' } });
    process.env.TIMESHEET_DISABLE_HOOKS = '1';
    expect(recordTurn({ cwd: '/w', ...turn }, { now, git: probe('/w', []) })).toBe(false);
    expect(sessionStartContext({ cwd: '/x' }, { now, git: probe('/x', []) })).toBeNull();
  });

  it('nudges on Sunday evening when the week has activity and is not pushed', () => {
    saveConfig(testConfig({ nudge: true }));
    saveRepos({ '/w': { class: 'work', project: 'Boxsy' } });
    const sunday = new Date(2026, 9, 11, 19, 0);
    appendLine(paths.log('2026-W41'), { t: sunday.toISOString() });
    expect(sessionStartContext({ cwd: '/w' }, { now: sunday, git: probe('/w', []) })).toMatch(/run \/timesheet/);
    const d = emptyDraft('2026-W41'); d.pushed = true; saveDraft(d);
    expect(sessionStartContext({ cwd: '/w' }, { now: sunday, git: probe('/w', []) })).toBeNull();
  });

  it('recordTurn is fast (< 50ms) with a fake git', () => {
    saveConfig(testConfig());
    saveRepos({ '/w': { class: 'work', project: 'Boxsy' } });
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) recordTurn({ cwd: '/w', ...turn }, { now, git: probe('/w', []) });
    expect((performance.now() - t0) / 20).toBeLessThan(50);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/hooks.test.ts`
Expected: FAIL. The hook modules can't be found.

- [ ] **Step 3: Write `src/hooks/common.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { paths } from '../lib/paths.js';

export const hooksDisabled = (): boolean => process.env.TIMESHEET_DISABLE_HOOKS === '1';

export function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export function logHookError(hook: string, e: unknown): void {
  try {
    fs.mkdirSync(path.dirname(paths.hookErrors()), { recursive: true });
    const msg = e instanceof Error ? e.stack ?? e.message : String(e);
    fs.appendFileSync(paths.hookErrors(), `${new Date().toISOString()} ${hook} ${msg}\n`);
  } catch { /* never throw from a hook */ }
}

export function isMain(metaUrl: string): boolean {
  try {
    return !!process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === metaUrl;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Write `src/hooks/session-start.ts`**

```ts
import fs from 'node:fs';
import { classify, realGit, setRepo, type GitProbe } from '../lib/repo.js';
import { loadConfig, loadDraft, loadRepos } from '../lib/store.js';
import { paths } from '../lib/paths.js';
import { isoWeek, shiftWeek } from '../lib/week.js';
import type { Config } from '../lib/types.js';
import { hooksDisabled, isMain, logHookError, readStdin } from './common.js';

const billable = (c: Config) => c.projects.filter(p => p.kind === 'billable').map(p => p.name).join(', ');

function askClass(root: string, slug: string | null, c: Config): string {
  return [
    `my-timesheet: this folder (${root}${slug ? ` — ${slug}` : ''}) is not classified yet, so no work is being logged here.`,
    `Early in this session, at a natural moment, ask the user once: is this Work, Personal, or Ignore?`,
    `If Work, also ask which billable project it belongs to (${billable(c)}).`,
    `Then run: timesheet repo <work|personal|ignore> --path "${root}" [--project "<name>"]. Do not bring it up again.`,
  ].join(' ');
}

function askProject(root: string, name: string, c: Config): string {
  return `my-timesheet: ${name} is a work repo but has no billable project yet. Ask the user once which project it bills to (${billable(c)}), then run: timesheet repo work --path "${root}" --project "<name>".`;
}

function nudge(c: Config, now: Date): string | null {
  if (!c.nudge) return null;
  const dow = now.getDay();
  const isSundayEvening = dow === 0 && now.getHours() >= 18;
  const isMonday = dow === 1;
  if (!isSundayEvening && !isMonday) return null;
  const week = isMonday ? shiftWeek(isoWeek(now), -1) : isoWeek(now);
  if (!fs.existsSync(paths.log(week))) return null;
  if (loadDraft(week)?.pushed) return null;
  return `my-timesheet: the timesheet for ${week} hasn't been pushed. Mention once, briefly, that the user can run /timesheet${isMonday ? ' last' : ''}.`;
}

export function sessionStartContext(input: { cwd: string }, deps: { now: Date; git: GitProbe }): string | null {
  if (hooksDisabled()) return null;
  const config = loadConfig();
  if (!config) return null;
  const c = classify(input.cwd, loadRepos(), config.workOrgs, deps.git);
  const lines: string[] = [];
  if (c.kind === 'org') {
    setRepo(c.root, c.entry);
    lines.push(askProject(c.root, c.entry.name ?? c.root, config));
  } else if (c.kind === 'unknown') {
    lines.push(askClass(c.root, c.slug, config));
  } else if (c.entry.class === 'work' && !c.entry.project) {
    lines.push(askProject(c.root, c.entry.name ?? c.root, config));
  }
  const n = nudge(config, deps.now);
  if (n) lines.push(n);
  return lines.length ? lines.join('\n\n') : null;
}

async function main(): Promise<void> {
  try {
    const input = JSON.parse(await readStdin()) as { cwd: string };
    const ctx = sessionStartContext(input, { now: new Date(), git: realGit });
    if (ctx) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }));
  } catch (e) {
    logHookError('session-start', e);
  }
  process.exit(0);
}

if (isMain(import.meta.url)) void main();
```

- [ ] **Step 5: Write `src/hooks/stop.ts`**

```ts
import { classify, realGit, type GitProbe } from '../lib/repo.js';
import { appendLine, loadConfig, loadRepos } from '../lib/store.js';
import { paths } from '../lib/paths.js';
import { isoWeek } from '../lib/week.js';
import type { LogEntry } from '../lib/types.js';
import { hooksDisabled, isMain, logHookError, readStdin } from './common.js';

export function recordTurn(
  input: { cwd: string; session_id: string; transcript_path: string },
  deps: { now: Date; git: GitProbe },
): boolean {
  if (hooksDisabled()) return false;
  const config = loadConfig();
  if (!config) return false;
  const c = classify(input.cwd, loadRepos(), config.workOrgs, deps.git);
  if (c.kind === 'unknown' || c.entry.class !== 'work') return false;
  const entry: LogEntry = {
    t: deps.now.toISOString(),
    session: input.session_id,
    root: c.root,
    repo: c.entry.name ?? c.root,
    project: c.entry.project ?? null,
    transcript: input.transcript_path,
  };
  appendLine(paths.log(isoWeek(deps.now)), entry);
  return true;
}

async function main(): Promise<void> {
  try {
    const input = JSON.parse(await readStdin());
    recordTurn(input, { now: new Date(), git: realGit });
  } catch (e) {
    logHookError('stop', e);
  }
  process.exit(0);
}

if (isMain(import.meta.url)) void main();
```

- [ ] **Step 6: Run the in-process tests and confirm they pass**

Run: `npm test -- tests/hooks.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Write the process-level tests in `tests/hooks.process.test.ts` (Review Focus #1)**

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { tmpDir, tmpHome, testConfig } from './helpers.js';
import { saveConfig } from '../src/lib/store.js';
import { paths } from '../src/lib/paths.js';

const runHook = (name: string, stdin: string) =>
  spawnSync('node', [path.resolve('dist/hooks', `${name}.js`)], { input: stdin, env: { ...process.env }, encoding: 'utf8' });

describe('hook processes', () => {
  beforeAll(() => { execSync('npm run build', { stdio: 'ignore' }); });
  beforeEach(() => { tmpHome(); saveConfig(testConfig()); });

  it('exits 0 and writes nothing for a deleted cwd with spaces', () => {
    const cwd = path.join(tmpDir(), 'gone folder', 'sub dir');
    const r = runHook('stop', JSON.stringify({ cwd, session_id: 's', transcript_path: '/t.jsonl' }));
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.dirname(paths.log('2026-W41')))).toBe(false);
  });

  it('exits 0 on garbage stdin and records the error', () => {
    const r = runHook('session-start', 'not json');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(paths.hookErrors(), 'utf8')).toMatch(/session-start/);
  });

  it('prints additionalContext JSON for an unknown folder', () => {
    const r = runHook('session-start', JSON.stringify({ cwd: tmpDir() }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe('SessionStart');
  });
});
```

The build needs a `src/server/public` folder to exist for `copy-assets.mjs`. Create an empty placeholder now; Task 16 fills it in:

```bash
mkdir -p src/server/public && touch src/server/public/.keep
```

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/hooks src/server/public/.keep tests/hooks.test.ts tests/hooks.process.test.ts
git commit -m "feat: SessionStart and Stop hooks that index work sessions only"
```

---

### Task 4: Transcript condenser (`condense.ts`)

**Files:**
- Create: `src/lib/condense.ts`
- Test: `tests/condense.test.ts`

**Interfaces:**
- Consumes: `Digest`, `DayActivity` (Task 1); `localDate` (Task 1).
- Produces: `condense(file: string, session: string, from: Date, to: Date): Digest`.

The transcript format was checked against a real file on 2026-10-06. Each line is JSON with `type` (`user` / `assistant` / others), `timestamp` (ISO), `isMeta?`, and `message.content`. That content is either a string (a user prompt) or an array of blocks: `text`, `thinking`, `tool_use {name, input}` or `tool_result`.

- [ ] **Step 1: Write the failing tests (covers Review Focus #3)**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.js';
import { condense } from '../src/lib/condense.js';

const write = (lines: unknown[]): string => {
  const f = path.join(tmpDir(), 's.jsonl');
  fs.writeFileSync(f, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return f;
};
const user = (t: string, content: string, extra = {}) => ({ type: 'user', timestamp: t, message: { role: 'user', content }, ...extra });
const asst = (t: string, blocks: unknown[]) => ({ type: 'assistant', timestamp: t, message: { role: 'assistant', content: blocks } });
const from = new Date('2026-10-05T00:00:00Z');
const to = new Date('2026-10-12T00:00:00Z');

describe('condense', () => {
  const tz = process.env.TZ;
  afterEach(() => { process.env.TZ = tz; });

  it('keeps prompts, edited files, commands and long replies; skips meta, tags and junk', () => {
    const f = write([
      user('2026-10-05T09:00:00Z', 'build the prefill extract endpoint'),
      user('2026-10-05T09:00:01Z', 'skill text', { isMeta: true }),
      user('2026-10-05T09:00:02Z', '<command-name>/clear</command-name>'),
      '{this is not json',
      asst('2026-10-05T09:01:00Z', [
        { type: 'thinking', thinking: '' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/r/api/prefill.py' } },
        { type: 'tool_use', name: 'Write', input: { file_path: '/r/api/prefill.py' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'pytest tests/test_prefill.py -q\necho done' } },
        { type: 'text', text: 'ok' },
        { type: 'text', text: 'Added the extract endpoint with a 25 MB limit and MIME sniffing for PDF and PPTX.' },
      ]),
      { type: 'user', timestamp: '2026-10-05T09:02:00Z', message: { content: [{ type: 'tool_result', content: 'x'.repeat(5000) }] } },
      user('2026-09-30T09:00:00Z', 'last week prompt'),
    ]);
    const d = condense(f, 's1', from, to);
    expect(d.missing).toBe(false);
    expect(d.prompts).toEqual(['build the prefill extract endpoint']);
    expect(d.filesEdited).toEqual(['/r/api/prefill.py']);
    expect(d.commands).toEqual(['pytest tests/test_prefill.py -q']);
    expect(d.replies).toEqual(['Added the extract endpoint with a 25 MB limit and MIME sniffing for PDF and PPTX.']);
    expect(d.days).toEqual({ '2026-10-05': { turns: 1, first: '2026-10-05T09:00:00Z', last: '2026-10-05T09:00:00Z' } });
  });

  it('assigns turns to the local date (IST, near midnight UTC)', () => {
    process.env.TZ = 'Asia/Kolkata';
    const f = write([user('2026-10-05T19:00:00Z', 'late night work in India')]);
    const d = condense(f, 's1', new Date('2026-10-04T18:30:00Z'), new Date('2026-10-11T18:30:00Z'));
    expect(Object.keys(d.days)).toEqual(['2026-10-06']);
  });

  it('flags missing transcripts and clips long prompts', () => {
    expect(condense('/nope/x.jsonl', 's', from, to).missing).toBe(true);
    const f = write([user('2026-10-06T10:00:00Z', 'a'.repeat(1000))]);
    const p = condense(f, 's', from, to).prompts[0];
    expect(p.length).toBe(300);
    expect(p.endsWith('…')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/condense.test.ts`
Expected: FAIL. The module can't be found.

- [ ] **Step 3: Write `src/lib/condense.ts`**

```ts
import fs from 'node:fs';
import { localDate } from './week.js';
import type { Digest } from './types.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_PROMPTS = 40;
const MAX_FILES = 60;
const MAX_COMMANDS = 30;
const MAX_REPLIES = 15;

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function condense(file: string, session: string, from: Date, to: Date): Digest {
  const digest: Digest = { session, transcript: file, missing: false, prompts: [], filesEdited: [], commands: [], replies: [], days: {} };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ...digest, missing: true };
  }
  const files = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (typeof o?.timestamp !== 'string') continue;
    const ts = new Date(o.timestamp);
    if (Number.isNaN(ts.getTime()) || ts < from || ts >= to) continue;
    const content = o.message?.content;
    if (o.type === 'user' && !o.isMeta && typeof content === 'string' && !content.trimStart().startsWith('<')) {
      if (digest.prompts.length < MAX_PROMPTS) digest.prompts.push(clip(content, 300));
      const day = localDate(ts);
      const a = (digest.days[day] ??= { turns: 0, first: o.timestamp, last: o.timestamp });
      a.turns += 1;
      if (o.timestamp < a.first) a.first = o.timestamp;
      if (o.timestamp > a.last) a.last = o.timestamp;
    } else if (o.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use') {
          const fp = b.input?.file_path ?? b.input?.notebook_path;
          if (EDIT_TOOLS.has(b.name) && typeof fp === 'string') files.add(fp);
          if (b.name === 'Bash' && typeof b.input?.command === 'string' && digest.commands.length < MAX_COMMANDS) {
            digest.commands.push(clip(b.input.command.split('\n')[0], 160));
          }
        } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length >= 40) {
          digest.replies.push(clip(b.text, 300));
          if (digest.replies.length > MAX_REPLIES) digest.replies.shift();
        }
      }
    }
  }
  digest.filesEdited = [...files].slice(0, MAX_FILES);
  return digest;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- tests/condense.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/condense.ts tests/condense.test.ts
git commit -m "feat: condense Claude transcripts into compact weekly digests"
```

---

### Task 5: Git evidence (`evidence.ts`)

**Files:**
- Create: `src/lib/evidence.ts`
- Test: `tests/evidence.test.ts`

**Interfaces:**
- Consumes: `Commit`, `WeekEvidence`, `Item` (Task 1); `localDate` (Task 1).
- Produces:
  - `gitCommits(root: string, repo: string, authors: string[], from: Date, to: Date): Commit[]`
  - `interface EvidenceStats { commits; insertions; deletions; files; prompts; sessions; activeDays }` (all numbers)
  - `statsFor(item: Item, ev: WeekEvidence): EvidenceStats`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, makeItem } from './helpers.js';
import { gitCommits, statsFor } from '../src/lib/evidence.js';

function commit(repo: string, email: string, iso: string, file: string, lines: number) {
  fs.writeFileSync(path.join(repo, file), 'x\n'.repeat(lines));
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', `user.email=${email}`, '-c', 'user.name=n', 'commit', '-q', '-m', `add ${file}`], {
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
}

describe('gitCommits', () => {
  it('returns only my commits inside the week with numstat totals', () => {
    const repo = tmpDir();
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    commit(repo, 'me@x.ai', '2026-10-01T10:00:00Z', 'old.txt', 1);
    commit(repo, 'me@x.ai', '2026-10-06T10:00:00Z', 'a.txt', 3);
    commit(repo, 'other@x.ai', '2026-10-06T11:00:00Z', 'b.txt', 2);
    const cs = gitCommits(repo, 'TheAgenticAI/demo', ['me@x.ai'], new Date('2026-10-05T00:00:00Z'), new Date('2026-10-12T00:00:00Z'));
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ repo: 'TheAgenticAI/demo', day: '2026-10-06', subject: 'add a.txt', files: ['a.txt'], insertions: 3, deletions: 0 });
  });

  it('returns [] for a non-repo or no authors', () => {
    expect(gitCommits(tmpDir(), 'x', ['me@x.ai'], new Date(0), new Date())).toEqual([]);
    expect(gitCommits(tmpDir(), 'x', [], new Date(0), new Date())).toEqual([]);
  });
});

describe('statsFor', () => {
  it('sums commit and session evidence', () => {
    const item = makeItem({ evidence: { commits: ['c1', 'c2', 'missing'], sessions: ['s1'], manual: false } });
    const ev = {
      commits: {
        c1: { sha: 'c1', root: '/r', repo: 'r', at: '', day: '2026-10-05', subject: '', files: ['a', 'b'], insertions: 10, deletions: 2 },
        c2: { sha: 'c2', root: '/r', repo: 'r', at: '', day: '2026-10-06', subject: '', files: ['b'], insertions: 5, deletions: 0 },
      },
      sessions: { s1: { repo: 'r', project: null, prompts: 7, days: { '2026-10-05': { turns: 7, first: '', last: '' } } } },
    };
    expect(statsFor(item, ev)).toEqual({ commits: 2, insertions: 15, deletions: 2, files: 2, prompts: 7, sessions: 1, activeDays: 2 });
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/evidence.test.ts`
Expected: FAIL. The module can't be found.

- [ ] **Step 3: Write `src/lib/evidence.ts`**

```ts
import { execFileSync } from 'node:child_process';
import { localDate } from './week.js';
import type { Commit, Item, WeekEvidence } from './types.js';

export function gitCommits(root: string, repo: string, authors: string[], from: Date, to: Date): Commit[] {
  if (!authors.length) return [];
  const args = [
    '-C', root, 'log', '--all', '--no-merges',
    `--since=${from.toISOString()}`, `--until=${to.toISOString()}`,
    ...authors.map(a => `--author=${a}`),
    '--format=%x1e%H%x1f%aI%x1f%s', '--numstat',
  ];
  let out: string;
  try {
    out = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const commits: Commit[] = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue;
    const [header, ...rest] = rec.split('\n');
    const [sha, at, subject] = header.split('\x1f');
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    const when = new Date(at);
    if (when < from || when >= to) continue;
    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const l of rest) {
      const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      files.push(m[3]);
      if (m[1] !== '-') insertions += Number(m[1]);
      if (m[2] !== '-') deletions += Number(m[2]);
    }
    commits.push({ sha, root, repo, at, day: localDate(when), subject, files, insertions, deletions });
  }
  return commits.sort((a, b) => a.at.localeCompare(b.at));
}

export interface EvidenceStats { commits: number; insertions: number; deletions: number; files: number; prompts: number; sessions: number; activeDays: number }

export function statsFor(item: Item, ev: WeekEvidence): EvidenceStats {
  const commits = item.evidence.commits.map(sha => ev.commits[sha]).filter(Boolean);
  const sessions = item.evidence.sessions.map(id => ev.sessions[id]).filter(Boolean);
  const files = new Set(commits.flatMap(c => c.files));
  const days = new Set([...commits.map(c => c.day), ...sessions.flatMap(s => Object.keys(s.days))]);
  return {
    commits: commits.length,
    insertions: commits.reduce((s, c) => s + c.insertions, 0),
    deletions: commits.reduce((s, c) => s + c.deletions, 0),
    files: files.size,
    prompts: sessions.reduce((s, x) => s + x.prompts, 0),
    sessions: sessions.length,
    activeDays: days.size,
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- tests/evidence.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/evidence.ts tests/evidence.test.ts
git commit -m "feat: collect weekly git commits and per-item evidence stats"
```

---

### Task 6: Draft merge and parents (`merge.ts`, `parents.ts`)

**Files:**
- Create: `src/lib/merge.ts`, `src/lib/parents.ts`
- Test: `tests/merge.test.ts`, `tests/parents.test.ts`

**Interfaces:**
- Consumes: `Draft`, `Item`, `Parent`, `ProposedItem`, `ProposedParent` (Task 1); `weekdayName` (Task 1).
- Produces:
  - `newItem(p: ProposedItem, id: string): Item`
  - `mergeProposal(draft: Draft, proposed: ProposedItem[], newId?: () => string): { draft: Draft; added: number; updated: number; skipped: number }` (mutates and returns `draft`)
  - `parentKey(day: string, project: string): string`
  - `withCount(desc: string, n: number): string`
  - `syncParents(draft: Draft, proposed?: ProposedParent[]): Draft` (mutates and returns `draft`)

Merge rules (from spec §6):
- **Proposal with an id that matches an item:**
  - pushed (`linear` set) or deleted → skipped;
  - `edited` → only the evidence is unioned;
  - otherwise the text, project, day and reason are replaced and the evidence is unioned.
- **Proposal without an id:**
  - **skipped** if it has ≥1 commit and every one of its commits already belongs to some item, including deleted ones;
  - **skipped** if it has no commits and a *deleted* item on the same day already covers all of its sessions;
  - otherwise it's added.
- Items that aren't in the proposal are always kept.

- [ ] **Step 1: Write the failing merge tests**

```ts
import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem } from './helpers.js';
import { mergeProposal } from '../src/lib/merge.js';
import type { ProposedItem } from '../src/lib/types.js';

const p = (o: Partial<ProposedItem> = {}): ProposedItem => ({
  title: 'New work', description: 'Did it.', project: 'Boxsy', bucketReason: 'client', day: '2026-10-05',
  evidence: { commits: [], sessions: [] }, ...o,
});
let n = 0;
const ids = () => `n${++n}`;

describe('mergeProposal', () => {
  it('adds new items', () => {
    const r = mergeProposal(makeDraft(), [p({ evidence: { commits: ['c1'], sessions: ['s1'] } })], ids);
    expect(r.added).toBe(1);
    expect(r.draft.items[0]).toMatchObject({ title: 'New work', evidence: { commits: ['c1'], sessions: ['s1'], manual: false }, hours: null });
  });

  it('updates unedited items by id but only unions evidence on edited ones', () => {
    const d = makeDraft({ items: [
      makeItem({ id: 'a', title: 'Old', evidence: { commits: ['c1'], sessions: [], manual: false } }),
      makeItem({ id: 'b', title: 'Mine', edited: true }),
    ] });
    const r = mergeProposal(d, [
      p({ id: 'a', title: 'Renamed', evidence: { commits: ['c2'], sessions: [] } }),
      p({ id: 'b', title: 'Overwrite?', evidence: { commits: ['c3'], sessions: [] } }),
    ], ids);
    expect(r.updated).toBe(2);
    expect(d.items[0].title).toBe('Renamed');
    expect(d.items[0].evidence.commits).toEqual(['c1', 'c2']);
    expect(d.items[1].title).toBe('Mine');
    expect(d.items[1].evidence.commits).toEqual(['c3']);
  });

  it('never touches pushed or deleted items and never recreates tombstoned work', () => {
    const d = makeDraft({ items: [
      makeItem({ id: 'pushed', title: 'P', linear: { uuid: 'u', identifier: 'T-1', url: null, created: true } }),
      makeItem({ id: 'dead', deleted: true, evidence: { commits: ['c9'], sessions: ['s9'], manual: false } }),
    ] });
    const r = mergeProposal(d, [
      p({ id: 'pushed', title: 'changed' }),
      p({ title: 'Recreated from commit', evidence: { commits: ['c9'], sessions: [] } }),
      p({ title: 'Recreated from session', evidence: { commits: [], sessions: ['s9'] } }),
      p({ title: 'Genuinely new, same session other day', day: '2026-10-06', evidence: { commits: [], sessions: ['s9'] } }),
    ], ids);
    expect(d.items[0].title).toBe('P');
    expect(r.skipped).toBe(3);
    expect(r.added).toBe(1);
    expect(d.items.map(i => i.title)).toContain('Genuinely new, same session other day');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/merge.test.ts`
Expected: FAIL. The module can't be found.

- [ ] **Step 3: Write `src/lib/merge.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { Draft, Item, ProposedItem } from './types.js';

export function newItem(p: ProposedItem, id: string): Item {
  return {
    id,
    title: p.title.trim(),
    description: p.description.trim(),
    project: p.project,
    bucketReason: p.bucketReason,
    day: p.day,
    evidence: { commits: [...new Set(p.evidence.commits)], sessions: [...new Set(p.evidence.sessions)], manual: false },
    weight: null,
    weightReason: null,
    hours: null,
    locked: false,
    edited: false,
    deleted: false,
    linear: null,
    everhour: null,
  };
}

const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];

export function mergeProposal(
  draft: Draft,
  proposed: ProposedItem[],
  newId: () => string = () => randomUUID().slice(0, 8),
): { draft: Draft; added: number; updated: number; skipped: number } {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const coveredCommits = () => new Set(draft.items.flatMap(i => i.evidence.commits));

  for (const p of proposed) {
    const existing = p.id ? draft.items.find(i => i.id === p.id) : undefined;
    if (existing) {
      if (existing.linear || existing.deleted) { skipped++; continue; }
      existing.evidence.commits = union(existing.evidence.commits, p.evidence.commits);
      existing.evidence.sessions = union(existing.evidence.sessions, p.evidence.sessions);
      if (!existing.edited) {
        existing.title = p.title.trim();
        existing.description = p.description.trim();
        existing.project = p.project;
        existing.bucketReason = p.bucketReason;
        existing.day = p.day;
      }
      updated++;
      continue;
    }
    const commits = p.evidence.commits;
    if (commits.length > 0) {
      const covered = coveredCommits();
      if (commits.every(c => covered.has(c))) { skipped++; continue; }
    } else if (p.evidence.sessions.length > 0) {
      const tomb = draft.items.some(i => i.deleted && i.day === p.day && p.evidence.sessions.every(s => i.evidence.sessions.includes(s)));
      if (tomb) { skipped++; continue; }
    }
    draft.items.push(newItem(p, newId()));
    added++;
  }
  return { draft, added, updated, skipped };
}
```

- [ ] **Step 4: Run the merge tests and confirm they pass**

Run: `npm test -- tests/merge.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing parents tests**

```ts
import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem } from './helpers.js';
import { syncParents, withCount } from '../src/lib/parents.js';

describe('syncParents', () => {
  it('creates one parent per day × project with the sub-task count', () => {
    const d = makeDraft({ items: [
      makeItem({ day: '2026-10-05', project: 'Boxsy' }),
      makeItem({ day: '2026-10-05', project: 'Boxsy' }),
      makeItem({ day: '2026-10-05', project: 'Dev - Internal' }),
      makeItem({ day: '2026-10-06', project: 'Boxsy', deleted: true }),
    ] });
    syncParents(d, [{ key: '2026-10-05|Boxsy', title: 'Monday — Prefill polish', description: '## 2026-10-05\n\nPolished the prefill flow.' }]);
    expect(d.parents.map(p => p.key)).toEqual(['2026-10-05|Boxsy', '2026-10-05|Dev - Internal']);
    expect(d.parents[0]).toMatchObject({ title: 'Monday — Prefill polish', description: '## 2026-10-05\n\nPolished the prefill flow.\n\n2 sub-tasks.' });
    expect(d.parents[1].title).toBe('Monday — Dev - Internal');
    expect(d.parents[1].description).toBe('## 2026-10-05\n\n1 sub-task.');
  });

  it('keeps edited parent text, updates counts, and keeps pushed parents', () => {
    const d = makeDraft({
      items: [makeItem({ day: '2026-10-05' })],
      parents: [
        { key: '2026-10-05|Boxsy', title: 'Mine', description: '## 2026-10-05\n\nMy words.\n\n4 sub-tasks.', edited: true, linear: null },
        { key: '2026-10-07|Boxsy', title: 'Pushed', description: 'x', edited: false, linear: { uuid: 'u', identifier: 'T-1', url: null, created: true } },
      ],
    });
    syncParents(d, [{ key: '2026-10-05|Boxsy', title: 'Ignored', description: 'Ignored' }]);
    expect(d.parents[0]).toMatchObject({ title: 'Mine', description: '## 2026-10-05\n\nMy words.\n\n1 sub-task.' });
    expect(d.parents.map(p => p.key)).toContain('2026-10-07|Boxsy');
  });

  it('withCount replaces or appends', () => {
    expect(withCount('## d\n\n3 sub-tasks.', 5)).toBe('## d\n\n5 sub-tasks.');
    expect(withCount('## d', 1)).toBe('## d\n\n1 sub-task.');
  });
});
```

- [ ] **Step 6: Run the tests and confirm they fail**

Run: `npm test -- tests/parents.test.ts`
Expected: FAIL. The module can't be found.

- [ ] **Step 7: Write `src/lib/parents.ts`**

```ts
import { weekdayName } from './week.js';
import type { Draft, Parent, ProposedParent } from './types.js';

export const parentKey = (day: string, project: string): string => `${day}|${project}`;

export function withCount(desc: string, n: number): string {
  const line = `${n} sub-task${n === 1 ? '' : 's'}.`;
  return /\d+ sub-tasks?\.\s*$/.test(desc) ? desc.replace(/\d+ sub-tasks?\.\s*$/, line) : `${desc.trimEnd()}\n\n${line}`;
}

export function syncParents(draft: Draft, proposed: ProposedParent[] = []): Draft {
  const counts = new Map<string, number>();
  for (const i of draft.items) {
    if (i.deleted || !i.project) continue;
    const k = parentKey(i.day, i.project);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const existing = new Map(draft.parents.map(p => [p.key, p]));
  const suggestions = new Map(proposed.map(p => [p.key, p]));
  const out: Parent[] = [];
  for (const [key, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    const [day, project] = key.split('|');
    const p: Parent = existing.get(key) ?? { key, title: `${weekdayName(day)} — ${project}`, description: `## ${day}`, edited: false, linear: null };
    const s = suggestions.get(key);
    if (s && !p.edited && !p.linear) {
      p.title = s.title.trim();
      p.description = s.description.trim();
    }
    if (!p.linear) p.description = withCount(p.description, n);
    out.push(p);
  }
  for (const p of draft.parents) if (p.linear && !counts.has(p.key)) out.push(p);
  draft.parents = out;
  return draft;
}
```

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/merge.ts src/lib/parents.ts tests/merge.test.ts tests/parents.test.ts
git commit -m "feat: merge Claude proposals into the draft and derive daily parents"
```

---

### Task 7: Prepare and ingest (`draftflow.ts`)

**Files:**
- Create: `src/lib/draftflow.ts`
- Test: `tests/draftflow.test.ts`

**Interfaces:**
- Consumes:
  - `readJsonl`, `loadRepos`, `requireConfig`, `loadDraft`, `emptyDraft`, `saveDraft`, `writeJsonAtomic`, `readJson` (Task 1);
  - `paths`, `weekDays`, `weekWindow` (Task 1);
  - `condense` (Task 4); `gitCommits` (Task 5);
  - `mergeProposal` (Task 6); `syncParents` (Task 6).
- Produces:
  - `prepare(week: string): { contextPath: string; warnings: string[]; sessions: number; commits: number }`, which writes `context.json` (temporary) and `evidence.json` (kept).
  - `ingest(week: string): { added: number; updated: number; skipped: number; items: number }`, which reads `proposal.json`, merges, adds weekend days that have items to `draft.days`, syncs parents, saves, and deletes `context.json` and `proposal.json`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpHome, testConfig } from './helpers.js';
import { saveConfig, saveRepos, appendLine, loadDraft, writeJsonAtomic } from '../src/lib/store.js';
import { paths } from '../src/lib/paths.js';
import { prepare, ingest } from '../src/lib/draftflow.js';

describe('prepare / ingest', () => {
  let repo: string;
  beforeEach(() => {
    tmpHome();
    saveConfig(testConfig());
    repo = tmpDir();
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'a.py'), 'x\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=me@x.ai', '-c', 'user.name=n', 'commit', '-q', '-m', 'feat: a'], {
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-06T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-06T10:00:00Z' },
    });
    saveRepos({ [repo]: { class: 'work', project: 'Boxsy', name: 'TheAgenticAI/demo' }, '/personal': { class: 'personal' } });
    const transcript = path.join(tmpDir(), 's1.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: '2026-10-06T09:00:00Z', message: { content: 'add a.py' } }) + '\n');
    appendLine(paths.log('2026-W41'), { t: '2026-10-06T09:00:00Z', session: 's1', root: repo, repo: 'TheAgenticAI/demo', project: 'Boxsy', transcript });
    appendLine(paths.log('2026-W41'), { t: '2026-10-06T09:05:00Z', session: 's2', root: repo, repo: 'TheAgenticAI/demo', project: 'Boxsy', transcript: '/gone.jsonl' });
  });

  it('prepare writes a context bundle and evidence, warning about missing transcripts', () => {
    const r = prepare('2026-W41');
    expect(r.sessions).toBe(2);
    expect(r.commits).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/1 session transcript is missing/);
    const ctx = JSON.parse(fs.readFileSync(r.contextPath, 'utf8'));
    expect(ctx.projects).toEqual([{ name: 'Boxsy', kind: 'billable' }, { name: 'Dev - Internal', kind: 'internal' }]);
    expect(ctx.sessions[0].prompts).toEqual(['add a.py']);
    expect(ctx.commits[0].subject).toBe('feat: a');
    const ev = JSON.parse(fs.readFileSync(paths.evidence('2026-W41'), 'utf8'));
    expect(Object.keys(ev.commits)).toHaveLength(1);
    expect(ev.sessions.s1.prompts).toBe(1);
    expect(JSON.stringify(ev)).not.toContain('add a.py');
  });

  it('ingest merges the proposal, adds weekend days with items, and removes temp files', () => {
    const { contextPath } = prepare('2026-W41');
    const sha = JSON.parse(fs.readFileSync(contextPath, 'utf8')).commits[0].sha;
    writeJsonAtomic(paths.proposal('2026-W41'), {
      items: [
        { title: 'Prefill module', description: 'Added a.py.', project: 'Boxsy', bucketReason: 'client feature', day: '2026-10-06', evidence: { commits: [sha], sessions: ['s1'] } },
        { title: 'Weekend probe', description: 'Probed.', project: 'Dev - Internal', bucketReason: 'research', day: '2026-10-10', evidence: { commits: [], sessions: ['s2'] } },
      ],
      parents: [{ key: '2026-10-06|Boxsy', title: 'Tuesday — Prefill', description: '## 2026-10-06\n\nBuilt the prefill module.' }],
    });
    const r = ingest('2026-W41');
    expect(r).toMatchObject({ added: 2, items: 2 });
    const d = loadDraft('2026-W41')!;
    expect(d.days).toContain('2026-10-10');
    expect(d.parents.find(p => p.key === '2026-10-06|Boxsy')?.title).toBe('Tuesday — Prefill');
    expect(fs.existsSync(paths.context('2026-W41'))).toBe(false);
    expect(fs.existsSync(paths.proposal('2026-W41'))).toBe(false);
  });

  it('ingest rejects a malformed proposal without touching the draft', () => {
    writeJsonAtomic(paths.proposal('2026-W41'), { items: [{ title: 'no day' }] });
    expect(() => ingest('2026-W41')).toThrow(/proposal\.json item 0/);
    expect(loadDraft('2026-W41')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/draftflow.test.ts`
Expected: FAIL. The module can't be found.

- [ ] **Step 3: Write `src/lib/draftflow.ts`**

```ts
import fs from 'node:fs';
import { paths } from './paths.js';
import { emptyDraft, loadDraft, loadRepos, readJson, readJsonl, requireConfig, saveDraft, writeJsonAtomic } from './store.js';
import { weekDays, weekWindow } from './week.js';
import { condense } from './condense.js';
import { gitCommits } from './evidence.js';
import { mergeProposal } from './merge.js';
import { syncParents } from './parents.js';
import type { Commit, LogEntry, Proposal, WeekEvidence } from './types.js';

export function prepare(week: string): { contextPath: string; warnings: string[]; sessions: number; commits: number } {
  const config = requireConfig();
  const { from, to } = weekWindow(week);
  const warnings: string[] = [];

  const bySession = new Map<string, LogEntry>();
  for (const e of readJsonl<LogEntry>(paths.log(week))) if (!bySession.has(e.session)) bySession.set(e.session, e);
  const digests = [...bySession.values()].map(e => ({ ...condense(e.transcript, e.session, from, to), repo: e.repo, project: e.project }));
  const missing = digests.filter(d => d.missing).length;
  if (missing) warnings.push(`${missing} session transcript${missing === 1 ? ' is' : 's are'} missing (Claude Code deletes transcripts after 30 days); those sessions rely on commits only.`);

  const repos = loadRepos();
  const commits: Commit[] = [];
  for (const [root, entry] of Object.entries(repos)) {
    if (entry.class !== 'work') continue;
    commits.push(...gitCommits(root, entry.name ?? root, config.gitEmails, from, to));
  }

  const draft = loadDraft(week) ?? emptyDraft(week);
  const examples = readJsonl<unknown>(paths.examples()).slice(-30);

  const context = {
    week,
    days: weekDays(week),
    countedDays: draft.days,
    projects: config.projects.map(({ name, kind }) => ({ name, kind })),
    internalProject: config.internalProject,
    repos: Object.fromEntries(Object.entries(repos).filter(([, e]) => e.class === 'work').map(([root, e]) => [root, { name: e.name ?? root, project: e.project ?? null }])),
    sessions: digests.filter(d => !d.missing),
    commits: commits.map(c => ({ sha: c.sha, repo: c.repo, day: c.day, subject: c.subject, files: c.files.slice(0, 20), insertions: c.insertions, deletions: c.deletions })),
    existing: draft.items.map(i => ({ id: i.id, title: i.title, description: i.description, project: i.project, day: i.day, evidence: i.evidence, edited: i.edited, deleted: i.deleted, pushed: !!i.linear })),
    examples,
  };
  writeJsonAtomic(paths.context(week), context);

  const evidence: WeekEvidence = {
    commits: Object.fromEntries(commits.map(c => [c.sha, c])),
    sessions: Object.fromEntries(digests.map(d => [d.session, { repo: d.repo, project: d.project, prompts: d.prompts.length, days: d.days }])),
  };
  writeJsonAtomic(paths.evidence(week), evidence);

  return { contextPath: paths.context(week), warnings, sessions: digests.length, commits: commits.length };
}

function checkProposal(p: unknown): Proposal {
  const prop = p as Proposal;
  if (!prop || !Array.isArray(prop.items)) throw new Error('proposal.json must be an object with an "items" array.');
  prop.items.forEach((it, idx) => {
    const ok = it && typeof it.title === 'string' && typeof it.description === 'string' && typeof it.day === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(it.day) && it.evidence && Array.isArray(it.evidence.commits) && Array.isArray(it.evidence.sessions);
    if (!ok) throw new Error(`proposal.json item ${idx} needs title, description, day (YYYY-MM-DD) and evidence {commits, sessions}.`);
  });
  return prop;
}

export function ingest(week: string): { added: number; updated: number; skipped: number; items: number } {
  const proposal = checkProposal(readJson<unknown>(paths.proposal(week), null));
  const draft = loadDraft(week) ?? emptyDraft(week);
  const r = mergeProposal(draft, proposal.items.map(i => ({ ...i, project: i.project ?? null, bucketReason: i.bucketReason ?? '' })));
  const week7 = weekDays(week);
  for (const i of draft.items) if (!i.deleted && week7.includes(i.day) && !draft.days.includes(i.day)) draft.days.push(i.day);
  draft.days.sort();
  syncParents(draft, proposal.parents ?? []);
  saveDraft(draft);
  fs.rmSync(paths.context(week), { force: true });
  fs.rmSync(paths.proposal(week), { force: true });
  return { added: r.added, updated: r.updated, skipped: r.skipped, items: draft.items.filter(i => !i.deleted).length };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- tests/draftflow.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/draftflow.ts tests/draftflow.test.ts
git commit -m "feat: prepare weekly context bundles and ingest Claude proposals"
```

---

### Task 8: Hours maths, item edits and validation (`distribute.ts`, `edit.ts`, `validate.ts`)

**Files:**
- Create: `src/lib/distribute.ts`, `src/lib/edit.ts`, `src/lib/validate.ts`
- Test: `tests/distribute.test.ts`, `tests/edit.test.ts`, `tests/validate.test.ts`

**Interfaces:**
- Consumes: `Draft`, `Item`, `Warning`, `Evidence` (Task 1); `dayDistance` (Task 1).
- Produces from `distribute.ts`:
  - `UNIT = 0.5`, `MAX_ITEM_HOURS = 3`
  - `allocate(totalHours: number, items: {id: string; weight: number}[]): Map<string, number>`
  - `distribute(draft: Draft, opts?: {balance?: boolean}): {draft: Draft; needsSplit: string[]}`, which is pure and returns a clone
  - `balanceDays(draft: Draft): void`, which mutates
  - `nearestDay(day: string, days: string[]): string`
- Produces from `edit.ts` (all pure, each returns a clone):
  - `setHours(draft, id, hours): Draft`
  - `splitItem(draft, id, parts: {title, description}[]): Draft`
  - `mechanicalSplit(item: {title; description}, k: number): {title, description}[]`
  - `mergeItems(draft, ids: string[]): Draft`
  - `addManualItem(draft, {title, description, project, day}): Draft`
  - `deleteItem(draft, id): Draft`
- Produces from `validate.ts`: `validate(draft: Draft, projectNames: string[]): Warning[]`.

- [ ] **Step 1: Write the failing distribute tests (covers Review Focus #4)**

```ts
import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem } from './helpers.js';
import { allocate, distribute, balanceDays } from '../src/lib/distribute.js';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296); }

describe('allocate', () => {
  it('splits by weight with largest remainder', () => {
    expect([...allocate(4, [{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }])]).toEqual([['a', 3], ['b', 1]]);
  });

  it('always sums exactly, in 0.5h steps, each at least 0.5h (property)', () => {
    const r = rng(7);
    for (let n = 0; n < 300; n++) {
      const count = 1 + Math.floor(r() * 40);
      const items = Array.from({ length: count }, (_, i) => ({ id: `x${i}`, weight: 1 + Math.floor(r() * 10) }));
      const total = 0.5 * (count + Math.floor(r() * 120));
      const out = [...allocate(total, items).values()];
      expect(sum(out)).toBe(total);
      for (const h of out) { expect(h).toBeGreaterThanOrEqual(0.5); expect((h * 2) % 1).toBe(0); }
    }
  });

  it('rejects impossible totals with clear messages', () => {
    expect(() => allocate(67.3, [{ id: 'a', weight: 1 }])).toThrow(/multiple of 0.5h/);
    expect(() => allocate(1, [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }])).toThrow(/too little for 3 items/);
  });
});

describe('distribute', () => {
  it('respects locks and pushed items, fills the rest, and flags items over 3h', () => {
    const d = makeDraft({ totalHours: 10, items: [
      makeItem({ id: 'locked', hours: 2, locked: true }),
      makeItem({ id: 'pushed', hours: 1, linear: { uuid: 'u', identifier: 'T', url: null, created: true } }),
      makeItem({ id: 'big', weight: 10 }),
      makeItem({ id: 'small', weight: 1 }),
    ] });
    const { draft, needsSplit } = distribute(d);
    expect(draft.items.find(i => i.id === 'locked')!.hours).toBe(2);
    expect(sum(draft.items.map(i => i.hours ?? 0))).toBe(10);
    expect(needsSplit).toEqual(['big']);
    expect(d.items[2].hours).toBeNull();
  });

  it('errors when locked hours exceed the total or the total is missing', () => {
    expect(() => distribute(makeDraft({ totalHours: 1, items: [makeItem({ hours: 2, locked: true })] }))).toThrow(/more than the 1h total/);
    expect(() => distribute(makeDraft({ items: [makeItem()] }))).toThrow(/Enter the total/);
  });
});

describe('balanceDays', () => {
  it('evens out days and moves items off uncounted days', () => {
    const items = Array.from({ length: 10 }, (_, i) => makeItem({ id: `m${i}`, day: '2026-10-05', hours: 2 }));
    items.push(makeItem({ id: 'sat', day: '2026-10-10', hours: 2 }));
    const d = makeDraft({ totalHours: 22, items });
    balanceDays(d);
    const load = new Map<string, number>();
    for (const i of d.items) load.set(i.day, (load.get(i.day) ?? 0) + i.hours!);
    expect([...load.keys()].sort()).toEqual(d.days);
    for (const v of load.values()) expect(Math.abs(v - 22 / 5)).toBeLessThanOrEqual(1);
  });

  it('never moves pushed items', () => {
    const pushed = makeItem({ id: 'p', day: '2026-10-05', hours: 3, linear: { uuid: 'u', identifier: 'T', url: null, created: true } });
    const d = makeDraft({ items: [pushed, makeItem({ day: '2026-10-05', hours: 3 })] });
    balanceDays(d);
    expect(d.items[0].day).toBe('2026-10-05');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/distribute.test.ts`
Expected: FAIL. The module can't be found.

- [ ] **Step 3: Write `src/lib/distribute.ts`**

```ts
import { dayDistance } from './week.js';
import type { Draft, Item } from './types.js';

export const UNIT = 0.5;
export const MAX_ITEM_HOURS = 3;
const EPS = 1e-9;

export function allocate(totalHours: number, items: { id: string; weight: number }[]): Map<string, number> {
  const units = Math.round(totalHours / UNIT);
  if (Math.abs(units * UNIT - totalHours) > EPS) throw new Error(`Total must be a multiple of ${UNIT}h (got ${totalHours}).`);
  const out = new Map<string, number>();
  if (items.length === 0) {
    if (units !== 0) throw new Error('There are no unlocked items to put the remaining hours on.');
    return out;
  }
  if (units < items.length) throw new Error(`${totalHours}h is too little for ${items.length} items (each needs at least ${UNIT}h).`);
  const weights = items.map(i => (Number.isFinite(i.weight) && i.weight > 0 ? i.weight : 1));
  const W = weights.reduce((a, b) => a + b, 0);
  const spare = units - items.length;
  const raw = weights.map(w => (spare * w) / W);
  const given = raw.map(Math.floor);
  let left = spare - given.reduce((a, b) => a + b, 0);
  const order = items.map((_, i) => i).sort((a, b) => (raw[b] - given[b]) - (raw[a] - given[a]) || items[a].id.localeCompare(items[b].id));
  for (const i of order) {
    if (left <= 0) break;
    given[i] += 1;
    left -= 1;
  }
  items.forEach((it, i) => out.set(it.id, (1 + given[i]) * UNIT));
  return out;
}

const isFixed = (i: Item): boolean => i.locked || i.linear !== null;
const roundH = (n: number): number => Math.round(n * 1e6) / 1e6;

export function distribute(input: Draft, opts: { balance?: boolean } = {}): { draft: Draft; needsSplit: string[] } {
  const draft = structuredClone(input);
  if (draft.totalHours == null) throw new Error('Enter the total hours for the week first.');
  const active = draft.items.filter(i => !i.deleted);
  const fixedSum = roundH(active.filter(isFixed).reduce((s, i) => s + (i.hours ?? 0), 0));
  const remaining = roundH(draft.totalHours - fixedSum);
  if (remaining < -EPS) throw new Error(`Locked items already add up to ${fixedSum}h, more than the ${draft.totalHours}h total.`);
  const free = active.filter(i => !isFixed(i));
  const alloc = allocate(Math.max(0, remaining), free.map(i => ({ id: i.id, weight: i.weight ?? 1 })));
  for (const i of free) i.hours = alloc.get(i.id)!;
  const needsSplit = free.filter(i => (i.hours ?? 0) > MAX_ITEM_HOURS).map(i => i.id);
  if (needsSplit.length === 0 && opts.balance !== false) balanceDays(draft);
  return { draft, needsSplit };
}

export function nearestDay(day: string, days: string[]): string {
  return [...days].sort((a, b) => dayDistance(day, a) - dayDistance(day, b) || a.localeCompare(b))[0];
}

/** Greedy: move items from the heaviest to the lightest day until every day is within ±1h of the average. */
export function balanceDays(draft: Draft): void {
  const days = [...draft.days].sort();
  if (days.length === 0) return;
  const items = draft.items.filter(i => !i.deleted);
  for (const i of items) if (!i.linear && !days.includes(i.day)) i.day = nearestDay(i.day, days);
  const load = new Map(days.map(d => [d, 0]));
  for (const i of items) if (load.has(i.day)) load.set(i.day, load.get(i.day)! + (i.hours ?? 0));
  const avg = [...load.values()].reduce((a, b) => a + b, 0) / days.length;
  for (let guard = 0; guard < 1000; guard++) {
    const sorted = [...load].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [hi, hiLoad] = sorted[0];
    const [lo, loLoad] = sorted[sorted.length - 1];
    if (hiLoad - avg <= 1 + EPS && avg - loLoad <= 1 + EPS) break;
    const spread = hiLoad - loLoad;
    const candidates = items.filter(i => i.day === hi && !i.linear && (i.hours ?? 0) > 0 && (i.hours ?? 0) < spread - EPS);
    if (!candidates.length) break;
    candidates.sort((a, b) => Math.abs(spread - 2 * a.hours!) - Math.abs(spread - 2 * b.hours!) || a.id.localeCompare(b.id));
    const pick = candidates[0];
    pick.day = lo;
    load.set(hi, hiLoad - pick.hours!);
    load.set(lo, loLoad + pick.hours!);
  }
}
```

- [ ] **Step 4: Run the distribute tests and confirm they pass**

Run: `npm test -- tests/distribute.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing edit tests**

```ts
import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem } from './helpers.js';
import { setHours, splitItem, mechanicalSplit, mergeItems, addManualItem, deleteItem } from '../src/lib/edit.js';

const pushedRef = { uuid: 'u', identifier: 'T-1', url: null, created: true };

describe('edit', () => {
  it('setHours locks the item and rebalances the rest to keep the total', () => {
    const d = makeDraft({ totalHours: 6, items: [makeItem({ id: 'a', hours: 2 }), makeItem({ id: 'b', hours: 2 }), makeItem({ id: 'c', hours: 2 })] });
    const out = setHours(d, 'a', 3);
    expect(out.items[0]).toMatchObject({ hours: 3, locked: true });
    expect(out.items[1].hours! + out.items[2].hours!).toBe(3);
    expect(d.items[0].hours).toBe(2);
  });

  it('setHours rejects pushed items and impossible values', () => {
    const d = makeDraft({ totalHours: 4, items: [makeItem({ id: 'a', hours: 2, linear: pushedRef }), makeItem({ id: 'b', hours: 2 })] });
    expect(() => setHours(d, 'a', 1)).toThrow(/already pushed/);
    expect(() => setHours(d, 'b', 9)).toThrow(/more than the 4h total/);
  });

  it('splitItem replaces an item with parts sharing evidence and weight', () => {
    const d = makeDraft({ items: [makeItem({ id: 'x', weight: 9, evidence: { commits: ['c'], sessions: [], manual: false } })] });
    const out = splitItem(d, 'x', mechanicalSplit({ title: 'Harness', description: 'Built it.' }, 3));
    expect(out.items.map(i => i.id)).toEqual(['x-1', 'x-2', 'x-3']);
    expect(out.items.map(i => i.title)).toEqual(['Harness 1/3', 'Harness 2/3', 'Harness 3/3']);
    expect(out.items.every(i => i.weight === 3 && i.evidence.commits[0] === 'c' && i.hours === null)).toBe(true);
  });

  it('mergeItems combines two items into the first', () => {
    const d = makeDraft({ items: [
      makeItem({ id: 'a', title: 'A', description: 'One.', weight: 2, hours: 1, evidence: { commits: ['c1'], sessions: [], manual: false } }),
      makeItem({ id: 'b', title: 'B', description: 'Two.', weight: 3, hours: 2, evidence: { commits: ['c2'], sessions: ['s'], manual: false } }),
    ] });
    const out = mergeItems(d, ['a', 'b']);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ id: 'a', title: 'A', description: 'One. Two.', weight: 5, hours: 3, edited: true });
    expect(out.items[0].evidence).toEqual({ commits: ['c1', 'c2'], sessions: ['s'], manual: false });
  });

  it('addManualItem and deleteItem', () => {
    let d = addManualItem(makeDraft(), { title: 'Client call', description: 'Weekly sync.', project: 'Boxsy', day: '2026-10-06' });
    expect(d.items[0]).toMatchObject({ title: 'Client call', evidence: { manual: true }, edited: true });
    d = deleteItem(d, d.items[0].id);
    expect(d.items[0]).toMatchObject({ deleted: true, hours: null });
    const p = makeDraft({ items: [makeItem({ id: 'p', linear: pushedRef })] });
    expect(() => deleteItem(p, 'p')).toThrow(/already pushed/);
  });
});
```

- [ ] **Step 6: Run the tests and confirm they fail**

Run: `npm test -- tests/edit.test.ts`
Expected: FAIL. The module can't be found.

- [ ] **Step 7: Write `src/lib/edit.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { distribute } from './distribute.js';
import type { Draft, Item } from './types.js';

function find(draft: Draft, id: string): Item {
  const item = draft.items.find(i => i.id === id && !i.deleted);
  if (!item) throw new Error(`No item ${id}.`);
  if (item.linear) throw new Error(`"${item.title}" is already pushed and can't be changed here.`);
  return item;
}

export function setHours(input: Draft, id: string, hours: number): Draft {
  const draft = structuredClone(input);
  const item = find(draft, id);
  if (!(hours > 0)) throw new Error('Hours must be more than 0.');
  item.hours = hours;
  item.locked = true;
  if (draft.totalHours == null) return draft;
  return distribute(draft, { balance: false }).draft;
}

export function mechanicalSplit(item: { title: string; description: string }, k: number): { title: string; description: string }[] {
  return Array.from({ length: k }, (_, i) => ({ title: `${item.title} ${i + 1}/${k}`, description: item.description }));
}

export function splitItem(input: Draft, id: string, parts: { title: string; description: string }[]): Draft {
  const draft = structuredClone(input);
  const item = find(draft, id);
  if (parts.length < 2) throw new Error('A split needs at least 2 parts.');
  const w = (item.weight ?? 1) / parts.length;
  const replacements: Item[] = parts.map((p, k) => ({
    ...structuredClone(item),
    id: `${item.id}-${k + 1}`,
    title: p.title.trim(),
    description: p.description.trim(),
    weight: w,
    hours: null,
    locked: false,
    edited: false,
  }));
  draft.items.splice(draft.items.indexOf(item), 1, ...replacements);
  return draft;
}

export function mergeItems(input: Draft, ids: string[]): Draft {
  const draft = structuredClone(input);
  if (ids.length < 2) throw new Error('Pick at least 2 items to merge.');
  const [first, ...rest] = ids.map(id => find(draft, id));
  for (const other of rest) {
    first.description = `${first.description.trim()} ${other.description.trim()}`;
    first.evidence.commits = [...new Set([...first.evidence.commits, ...other.evidence.commits])];
    first.evidence.sessions = [...new Set([...first.evidence.sessions, ...other.evidence.sessions])];
    first.weight = (first.weight ?? 1) + (other.weight ?? 1);
    first.hours = first.hours != null && other.hours != null ? first.hours + other.hours : null;
    draft.items.splice(draft.items.indexOf(other), 1);
  }
  first.edited = true;
  first.locked = false;
  return draft;
}

export function addManualItem(input: Draft, a: { title: string; description: string; project: string | null; day: string }): Draft {
  const draft = structuredClone(input);
  draft.items.push({
    id: randomUUID().slice(0, 8),
    title: a.title.trim(),
    description: a.description.trim(),
    project: a.project,
    bucketReason: 'added by hand',
    day: a.day,
    evidence: { commits: [], sessions: [], manual: true },
    weight: null,
    weightReason: null,
    hours: null,
    locked: false,
    edited: true,
    deleted: false,
    linear: null,
    everhour: null,
  });
  return draft;
}

export function deleteItem(input: Draft, id: string): Draft {
  const draft = structuredClone(input);
  const item = find(draft, id);
  item.deleted = true;
  item.hours = null;
  item.locked = false;
  return draft;
}
```

- [ ] **Step 8: Write the failing validate tests**

```ts
import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem } from './helpers.js';
import { validate } from '../src/lib/validate.js';

const names = ['Boxsy', 'Dev - Internal'];
const codes = (d: ReturnType<typeof makeDraft>) => validate(d, names).map(w => `${w.level}:${w.code}`);

describe('validate', () => {
  it('blocks every unsafe state', () => {
    const d = makeDraft({ totalHours: 10, items: [
      makeItem({ id: 'a', project: null, hours: 2 }),
      makeItem({ id: 'b', project: 'Nope', hours: 4 }),
      makeItem({ id: 'c', hours: 1, day: '2026-10-11' }),
    ] });
    expect(codes(d)).toEqual(expect.arrayContaining([
      'block:no_project', 'block:unknown_project', 'block:over_cap', 'block:day_not_counted', 'block:total_mismatch', 'warn:week_under_45',
    ]));
  });

  it('flags missing total and missing hours, and warns about hours written in text', () => {
    const d = makeDraft({ items: [makeItem({ title: 'Audit (2h)', hours: null })] });
    expect(codes(d)).toEqual(expect.arrayContaining(['block:total_missing', 'block:no_hours', 'warn:hours_in_text']));
  });

  it('is clean for a good week and ignores pushed items for per-item checks', () => {
    const items = Array.from({ length: 16 }, (_, i) => makeItem({ hours: 3 }));
    items.push(makeItem({ hours: 2, day: '2026-10-11', linear: { uuid: 'u', identifier: 'T', url: null, created: true } }));
    expect(validate(makeDraft({ totalHours: 50, items }), names)).toEqual([]);
  });
});
```

- [ ] **Step 9: Write `src/lib/validate.ts`**

```ts
import { MAX_ITEM_HOURS } from './distribute.js';
import type { Draft, Warning } from './types.js';

export const HOURS_IN_TEXT = /\b\d+(?:\.\d+)?\s?(?:h|hrs?|hours?)\b/i;

export function validate(draft: Draft, projectNames: string[]): Warning[] {
  const w: Warning[] = [];
  const live = draft.items.filter(i => !i.deleted);
  if (!live.length) w.push({ level: 'warn', code: 'no_items', message: 'No items yet. Run /timesheet in Claude to draft this week.' });
  if (draft.totalHours == null) w.push({ level: 'block', code: 'total_missing', message: 'Enter the total hours for the week.' });
  for (const i of live) {
    if (i.linear?.created) continue;
    if (!i.project) w.push({ level: 'block', code: 'no_project', message: `"${i.title}" has no project.`, itemId: i.id });
    else if (!projectNames.includes(i.project)) w.push({ level: 'block', code: 'unknown_project', message: `"${i.title}" uses unknown project "${i.project}".`, itemId: i.id });
    if (i.hours == null) w.push({ level: 'block', code: 'no_hours', message: `"${i.title}" has no hours. Press Distribute.`, itemId: i.id });
    else if (i.hours > MAX_ITEM_HOURS) w.push({ level: 'block', code: 'over_cap', message: `"${i.title}" is ${i.hours}h; the limit is ${MAX_ITEM_HOURS}h per sub-issue.`, itemId: i.id });
    if (!draft.days.includes(i.day)) w.push({ level: 'block', code: 'day_not_counted', message: `"${i.title}" is on ${i.day}, which isn't a counted day.`, itemId: i.id });
    if (HOURS_IN_TEXT.test(i.title) || HOURS_IN_TEXT.test(i.description)) w.push({ level: 'warn', code: 'hours_in_text', message: `"${i.title}" mentions hours in its text.`, itemId: i.id });
  }
  if (draft.totalHours != null && live.length && live.every(i => i.hours != null)) {
    const sum = Math.round(live.reduce((s, i) => s + (i.hours ?? 0), 0) * 1e6) / 1e6;
    if (Math.abs(sum - draft.totalHours) > 1e-9) w.push({ level: 'block', code: 'total_mismatch', message: `Items add up to ${sum}h but the total is ${draft.totalHours}h.` });
    if (draft.totalHours < 45) w.push({ level: 'warn', code: 'week_under_45', message: `${draft.totalHours}h is under 45h. Is some work missing?` });
  }
  return w;
}
```

- [ ] **Step 10: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/lib/distribute.ts src/lib/edit.ts src/lib/validate.ts tests/distribute.test.ts tests/edit.test.ts tests/validate.test.ts
git commit -m "feat: exact hour allocation, day balancing, item edits and validation"
```

---

### Task 9: Weights via `claude -p` and the Distribute run (`weights.ts`)

**Files:**
- Create: `src/lib/weights.ts`
- Test: `tests/weights.test.ts`

**Interfaces:**
- Consumes:
  - `distribute`, `MAX_ITEM_HOURS` (Task 8);
  - `splitItem`, `mechanicalSplit` (Task 8);
  - `statsFor`, `EvidenceStats` (Task 5);
  - `syncParents` (Task 6);
  - `Draft`, `WeekEvidence` (Task 1).
- Produces:
  - `type ClaudeRunner = (prompt: string) => Promise<string>`
  - `runClaude: ClaudeRunner`, which spawns `claude -p` with `cwd = os.tmpdir()` and `TIMESHEET_DISABLE_HOOKS=1` (Review Focus #2)
  - `setSpawnForTests(fn | null): void`, a test seam for the spawn call
  - `extractJsonArray(text: string): unknown[]`
  - `claudeWeights(inputs: WeightInput[], run): Promise<Map<string, {weight: number; reason: string}>>`
  - `heuristicWeight(s: EvidenceStats): number`
  - `claudeSplits(items: {id, title, description, parts: number}[], run): Promise<Map<string, {title, description}[]>>`
  - `runDistribute(draft: Draft, opts: {reweight: boolean}, deps: {run: ClaudeRunner; evidence: WeekEvidence}): Promise<Draft>`
  - `interface WeightInput { id: string; title: string; description: string; evidence: EvidenceStats }`

- [ ] **Step 1: Write the failing tests**

```ts
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
});
```


- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/weights.test.ts`
Expected: FAIL. The module can't be found.

- [ ] **Step 3: Write `src/lib/weights.ts`**

```ts
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
    if (!e.parts.every((p: any) => typeof p?.title === 'string' && typeof p?.description === 'string')) continue;
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
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/weights.ts tests/weights.test.ts
git commit -m "feat: Claude effort weights with heuristic fallback and automatic splits"
```

---

### Task 10: HTTP retry and the Linear client (`http.ts`, `linear.ts`)

**Files:**
- Create: `src/lib/http.ts`, `src/lib/linear.ts`
- Test: `tests/http.test.ts`, `tests/linear.test.ts`

**Interfaces:**
- Produces:
  - `class HttpError extends Error { status: number; body: string }`
  - `interface RetryOpts { retries?; baseMs?; sleep?: (ms) => Promise<void>; fetchImpl?: typeof fetch }`
  - `request(url, init, opts?): Promise<{status: number; json: any}>`. It returns `{status: 404, json: null}` on 404, retries on network errors, 429 (honouring `Retry-After`) and 5xx, and throws `HttpError` on any other non-2xx.
  - `class Linear` with methods:
    - `viewer()`
    - `projects()`: `{id, name, teams: {id, name, key}[]}[]`
    - `states(teamId)`: `{id, name, type}[]`
    - `getIssue(id)`: `LinearIssueRef | null`
    - `createIssue(input: CreateIssueInput)`: `LinearIssueRef`
    - `deleteIssue(id)`
  - `interface LinearIssueRef { uuid; identifier; url }`
  - `interface CreateIssueInput { id; teamId; projectId; assigneeId; stateId; labelIds: string[]; parentId?; title; description }`
  - `type LinearApi = Pick<Linear, 'getIssue' | 'createIssue'>`

- [ ] **Step 1: Write the failing tests**

`tests/http.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { request, HttpError } from '../src/lib/http.js';

const res = (status: number, body = '{}', headers: Record<string, string> = {}) => new Response(body, { status, headers });

describe('request', () => {
  it('retries 429 using Retry-After, then succeeds', async () => {
    const waits: number[] = [];
    const queue = [res(429, '', { 'retry-after': '2' }), res(503), res(200, '{"ok":true}')];
    const r = await request('https://x', {}, { fetchImpl: async () => queue.shift()!, sleep: async ms => { waits.push(ms); }, baseMs: 10 });
    expect(r).toEqual({ status: 200, json: { ok: true } });
    expect(waits).toEqual([2000, 20]);
  });
  it('returns 404 without throwing and throws HttpError on 401', async () => {
    expect(await request('https://x', {}, { fetchImpl: async () => res(404) })).toEqual({ status: 404, json: null });
    await expect(request('https://x', {}, { fetchImpl: async () => res(401, 'bad key') })).rejects.toBeInstanceOf(HttpError);
  });
  it('retries network errors then gives up', async () => {
    let calls = 0;
    await expect(request('https://x', {}, { fetchImpl: async () => { calls++; throw new TypeError('fetch failed'); }, sleep: async () => {}, retries: 2 })).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(3);
  });
});
```

`tests/linear.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Linear } from '../src/lib/linear.js';

function fakeFetch(reply: (body: any) => unknown) {
  const calls: { headers: any; body: any }[] = [];
  const fetchImpl = async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ headers: init.headers, body });
    return new Response(JSON.stringify(reply(body)), { status: 200 });
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

describe('Linear', () => {
  it('sends the raw API key and creates issues with a client id', async () => {
    const f = fakeFetch(() => ({ data: { issueCreate: { success: true, issue: { id: 'uuid-1', identifier: 'THE-1', url: 'https://linear.app/t/THE-1' } } } }));
    const l = new Linear('lin_api_x', { fetchImpl: f.fetchImpl });
    const ref = await l.createIssue({ id: 'uuid-1', teamId: 't', projectId: 'p', assigneeId: 'a', stateId: 's', labelIds: [], title: 'T', description: 'D' });
    expect(ref).toEqual({ uuid: 'uuid-1', identifier: 'THE-1', url: 'https://linear.app/t/THE-1' });
    expect(f.calls[0].headers.Authorization).toBe('lin_api_x');
    expect(f.calls[0].body.variables.input).toMatchObject({ id: 'uuid-1', teamId: 't', title: 'T' });
    expect(f.calls[0].body.variables.input).not.toHaveProperty('parentId');
  });

  it('getIssue returns null for missing issues and throws other GraphQL errors', async () => {
    const missing = new Linear('k', { fetchImpl: fakeFetch(() => ({ errors: [{ message: 'Entity not found: Issue' }] })).fetchImpl });
    expect(await missing.getIssue('nope')).toBeNull();
    const broken = new Linear('k', { fetchImpl: fakeFetch(() => ({ errors: [{ message: 'Authentication required' }] })).fetchImpl });
    await expect(broken.viewer()).rejects.toThrow(/Authentication required/);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/http.test.ts tests/linear.test.ts`
Expected: FAIL. The modules can't be found.

- [ ] **Step 3: Write `src/lib/http.ts`**

```ts
export class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

export interface RetryOpts {
  retries?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export async function request(url: string, init: RequestInit, opts: RetryOpts = {}): Promise<{ status: number; json: any }> {
  const { retries = 5, baseMs = 500, sleep: wait = sleep, fetchImpl = fetch } = opts;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      if (attempt >= retries) throw e;
      await wait(baseMs * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw new HttpError(res.status, await res.text());
      const ra = Number(res.headers.get('retry-after'));
      await wait(Number.isFinite(ra) && ra > 0 ? ra * 1000 : baseMs * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (res.status === 404) return { status: 404, json: null };
    if (!res.ok) throw new HttpError(res.status, text);
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
}
```

- [ ] **Step 4: Write `src/lib/linear.ts`**

```ts
import { request, type RetryOpts } from './http.js';

const ENDPOINT = 'https://api.linear.app/graphql';

export interface LinearIssueRef { uuid: string; identifier: string; url: string }
export interface CreateIssueInput {
  id: string; teamId: string; projectId: string; assigneeId: string; stateId: string; labelIds: string[];
  parentId?: string; title: string; description: string;
}

export class Linear {
  constructor(private apiKey: string, private opts: RetryOpts = {}) {}

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const { json } = await request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
    }, this.opts);
    if (json?.errors?.length) throw new Error(`Linear: ${json.errors.map((e: { message: string }) => e.message).join('; ')}`);
    return json.data as T;
  }

  async viewer(): Promise<{ id: string; email: string; name: string }> {
    return (await this.gql<{ viewer: { id: string; email: string; name: string } }>('query { viewer { id email name } }')).viewer;
  }

  async projects(): Promise<{ id: string; name: string; teams: { id: string; name: string; key: string }[] }[]> {
    const d = await this.gql<any>('query { projects(first: 250) { nodes { id name teams { nodes { id name key } } } } }');
    return d.projects.nodes.map((p: any) => ({ id: p.id, name: p.name, teams: p.teams.nodes }));
  }

  async states(teamId: string): Promise<{ id: string; name: string; type: string }[]> {
    const d = await this.gql<any>('query($id: String!) { team(id: $id) { states { nodes { id name type } } } }', { id: teamId });
    return d.team.states.nodes;
  }

  async getIssue(id: string): Promise<LinearIssueRef | null> {
    try {
      const d = await this.gql<any>('query($id: String!) { issue(id: $id) { id identifier url } }', { id });
      return d.issue ? { uuid: d.issue.id, identifier: d.issue.identifier, url: d.issue.url } : null;
    } catch (e) {
      if (/not found/i.test((e as Error).message)) return null;
      throw e;
    }
  }

  async createIssue(input: CreateIssueInput): Promise<LinearIssueRef> {
    const d = await this.gql<any>(
      'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
      { input },
    );
    if (!d.issueCreate?.success) throw new Error('Linear: issueCreate returned success=false');
    const i = d.issueCreate.issue;
    return { uuid: i.id, identifier: i.identifier, url: i.url };
  }

  async deleteIssue(id: string): Promise<void> {
    await this.gql('mutation($id: String!) { issueDelete(id: $id) { success } }', { id });
  }
}

export type LinearApi = Pick<Linear, 'getIssue' | 'createIssue'>;
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -- tests/http.test.ts tests/linear.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/http.ts src/lib/linear.ts tests/http.test.ts tests/linear.test.ts
git commit -m "feat: retrying HTTP helper and Linear GraphQL client"
```

---

### Task 11: Everhour client (`everhour.ts`)

**Files:**
- Create: `src/lib/everhour.ts`
- Test: `tests/everhour.test.ts`

**Interfaces:**
- Consumes: `request`, `RetryOpts` (Task 10).
- Produces: `class Everhour` with these methods:
  - `me()`: `{id, name, email, linearConnected: boolean}`
  - `taskExists(issueUuid)`: `boolean`
  - `syncProject(projectUuid)`: `void`, best effort
  - `addTime({issueUuid, userId, date, hours})`: `void`, via `POST /time` (an upsert)
  - `userSeconds(userId, from, to)`: `number`

  It also exports `type EverhourApi = Pick<Everhour, 'taskExists' | 'syncProject' | 'addTime'>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { Everhour } from '../src/lib/everhour.js';

function fake(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: { method: string; url: string; body: any; headers: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const r = routes[`${init.method} ${url.replace('https://api.everhour.com', '')}`] ?? { status: 404 };
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('Everhour', () => {
  it('checks tasks by li:{uuid} and upserts time via POST /time', async () => {
    const f = fake({ 'GET /tasks/li:abc': { status: 200, body: { id: 'li:abc' } }, 'POST /time': { status: 201, body: {} } });
    const e = new Everhour('key', { fetchImpl: f.fetchImpl });
    expect(await e.taskExists('abc')).toBe(true);
    expect(await e.taskExists('missing')).toBe(false);
    await e.addTime({ issueUuid: 'abc', userId: 1400517, date: '2026-10-06', hours: 1.5 });
    const post = f.calls.find(c => c.method === 'POST')!;
    expect(post.body).toEqual({ task: 'li:abc', user: 1400517, date: '2026-10-06', time: 5400 });
    expect(post.headers['X-Api-Key']).toBe('key');
  });

  it('sums user seconds and reports the Linear integration', async () => {
    const f = fake({
      'GET /users/1/time?from=2026-10-05&to=2026-10-11&limit=10000': { status: 200, body: [{ time: 3600 }, { time: 1800 }] },
      'GET /users/me': { status: 200, body: { id: 1, name: 'Y', email: 'y@x', accounts: [{ platform: 'li' }] } },
    });
    const e = new Everhour('k', { fetchImpl: f.fetchImpl });
    expect(await e.userSeconds(1, '2026-10-05', '2026-10-11')).toBe(5400);
    expect(await e.me()).toEqual({ id: 1, name: 'Y', email: 'y@x', linearConnected: true });
  });

  it('syncProject never throws', async () => {
    const f = fake({ 'POST /projects/li:p/sync': { status: 400, body: { message: 'bad' } } });
    await expect(new Everhour('k', { fetchImpl: f.fetchImpl }).syncProject('p')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/everhour.test.ts`
Expected: FAIL. The module can't be found.

- [ ] **Step 3: Write `src/lib/everhour.ts`**

```ts
import { request, type RetryOpts } from './http.js';

const BASE = 'https://api.everhour.com';

export class Everhour {
  constructor(private apiKey: string, private opts: RetryOpts = {}) {}

  private req(method: string, p: string, body?: unknown) {
    return request(BASE + p, {
      method,
      headers: { 'X-Api-Key': this.apiKey, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, this.opts);
  }

  async me(): Promise<{ id: number; name: string; email: string; linearConnected: boolean }> {
    const { json } = await this.req('GET', '/users/me');
    const accounts: unknown[] = json.accounts ?? json.integrations ?? [];
    const linearConnected = accounts.some(a => (typeof a === 'string' ? a : (a as { platform?: string })?.platform) === 'li');
    return { id: json.id, name: json.name, email: json.email, linearConnected };
  }

  async taskExists(issueUuid: string): Promise<boolean> {
    return (await this.req('GET', `/tasks/li:${issueUuid}`)).status === 200;
  }

  /** Verified 2026-10-06: returns 200 but does not import new issues. Called anyway, best effort. */
  async syncProject(projectUuid: string): Promise<void> {
    try { await this.req('POST', `/projects/li:${projectUuid}/sync`); } catch { /* best effort */ }
  }

  /** POST /time upserts one record per (user, date, task), so repeating it is safe. */
  async addTime(a: { issueUuid: string; userId: number; date: string; hours: number }): Promise<void> {
    await this.req('POST', '/time', { task: `li:${a.issueUuid}`, user: a.userId, date: a.date, time: Math.round(a.hours * 3600) });
  }

  async userSeconds(userId: number, from: string, to: string): Promise<number> {
    const { json } = await this.req('GET', `/users/${userId}/time?from=${from}&to=${to}&limit=10000`);
    return (Array.isArray(json) ? json : []).reduce((s: number, r: { time?: number }) => s + (Number(r.time) || 0), 0);
  }
}

export type EverhourApi = Pick<Everhour, 'taskExists' | 'syncProject' | 'addTime'>;
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -- tests/everhour.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/everhour.ts tests/everhour.test.ts
git commit -m "feat: Everhour client with li: task ids and upserting time records"
```

---

### Task 12: Resumable push (`push.ts`)

**Files:**
- Create: `src/lib/push.ts`
- Test: `tests/fakes.ts`, `tests/push.test.ts`

**Interfaces:**
- Consumes:
  - `validate` (Task 8); `syncParents`, `parentKey` (Task 6);
  - `LinearApi`, `CreateIssueInput` (Task 10); `EverhourApi` (Task 11);
  - `Draft`, `Config`, `Item`, `LinearRef`, `Warning` (Task 1).
- Produces:
  - `type PushEvent = {phase: 'parents' | 'issues' | 'sync' | 'time'; done: number; total: number}`
  - `type PushResult = {status: 'blocked'; warnings: Warning[]} | {status: 'awaiting_sync'; missing: {identifier: string; project: string}[]} | {status: 'done'; issues: number; hours: number}`
  - `interface PushDeps { linear: LinearApi; everhour: EverhourApi; config: Config; save: (d: Draft) => void; newUuid?: () => string; onProgress?: (e: PushEvent) => void; concurrency?: number }`
  - `push(draft: Draft, deps: PushDeps): Promise<PushResult>`, which mutates `draft` and calls `save` after every state change
  - `pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void>`

- [ ] **Step 1: Write `tests/fakes.ts`**

```ts
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
```

- [ ] **Step 2: Write the failing push tests**

```ts
import { describe, it, expect } from 'vitest';
import { makeDraft, makeItem, testConfig } from './helpers.js';
import { FakeLinear, FakeEverhour } from './fakes.js';
import { push } from '../src/lib/push.js';
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
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npm test -- tests/push.test.ts`
Expected: FAIL. The module can't be found.

- [ ] **Step 4: Write `src/lib/push.ts`**

```ts
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

/** Runs fn with at most n in flight. After the first failure no new items start, so a failed push stops quickly. */
export async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (!failed && next < items.length) {
      const t = items[next++];
      try { await fn(t); } catch (e) { failed = true; throw e; }
    }
  });
  await Promise.all(workers);
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

  const pending: Item[] = draft.items.filter(i => !i.deleted && !i.everhour?.logged);
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
    if (!(await deps.everhour.taskExists(item.linear!.uuid))) missing.push(item);
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
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -- tests/push.test.ts`
Expected: PASS (5 tests). If the restart test fails with `duplicate id`, the bug is in `ensure`: it must call `getIssue` before `createIssue` whenever `created` is false.

- [ ] **Step 6: Commit**

```bash
git add src/lib/push.ts tests/fakes.ts tests/push.test.ts
git commit -m "feat: resumable push to Linear and Everhour with client-side issue ids"
```

---

### Task 13: Secrets and install (`keychain.ts`, `install.ts`)

**Files:**
- Create: `src/lib/keychain.ts`, `src/lib/install.ts`
- Test: `tests/keychain.test.ts`, `tests/install.test.ts`

**Interfaces:**
- Consumes: `readJson`, `writeJsonAtomic` (Task 1); `paths` (Task 1).
- Produces:
  - `type SecretName = 'linear' | 'everhour'`
  - `interface SecretStore { get(n: SecretName): string | null; set(n: SecretName, v: string): void; remove(n: SecretName): void }`
  - `secretStore(): SecretStore`: the Keychain on darwin unless `TIMESHEET_SECRETS_FILE` is set; otherwise a `0600` file
  - `claudeDir(): string`, `packageRoot(): string`
  - `HOOK_MARKER = '# my-timesheet'`, `hookCommand(pkgRoot, name): string`
  - `installHooks(pkgRoot): void`, `uninstallHooks(): void`, `hooksInstalled(): boolean`
  - `installSkillFiles(pkgRoot): string[]`, `uninstallSkillFiles(): void`

Hooks are identified by a trailing shell comment, `# my-timesheet`. A path match won't work, because `npm link` resolves to the dev folder (`timesheet skill`), whose path doesn't contain the package name.

- [ ] **Step 1: Write the failing tests**

`tests/keychain.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { tmpHome } from './helpers.js';
import { secretStore } from '../src/lib/keychain.js';
import { paths } from '../src/lib/paths.js';

describe('secretStore (file backend)', () => {
  beforeEach(() => { tmpHome(); });
  it('stores secrets in a 0600 file', () => {
    const s = secretStore();
    expect(s.get('linear')).toBeNull();
    s.set('linear', 'lin_api_123');
    expect(s.get('linear')).toBe('lin_api_123');
    expect(fs.statSync(paths.secrets()).mode & 0o777).toBe(0o600);
    s.remove('linear');
    expect(s.get('linear')).toBeNull();
  });
});
```

`tests/install.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, tmpHome } from './helpers.js';
import { installHooks, uninstallHooks, hooksInstalled, installSkillFiles, uninstallSkillFiles, claudeDir } from '../src/lib/install.js';

const existing = {
  theme: 'dark',
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node "/Users/y/.selflore/app/hooks/session-start.js"' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node "/Users/y/.selflore/app/hooks/stop.js"' }] }],
  },
};

describe('install', () => {
  let pkg: string;
  beforeEach(() => {
    tmpHome();
    pkg = path.join(tmpDir(), 'timesheet skill');
    fs.mkdirSync(path.join(pkg, 'skill', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'skill', 'SKILL.md'), '---\nname: timesheet\n---\n');
    fs.writeFileSync(path.join(pkg, 'skill', 'commands', 'timesheet.md'), 'cmd');
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(path.join(claudeDir(), 'settings.json'), JSON.stringify(existing));
  });

  it('adds quoted, marked hooks once and keeps everything else', () => {
    installHooks(pkg);
    installHooks(pkg);
    const s = JSON.parse(fs.readFileSync(path.join(claudeDir(), 'settings.json'), 'utf8'));
    expect(s.theme).toBe('dark');
    expect(s.hooks.SessionStart).toHaveLength(2);
    expect(s.hooks.SessionStart[0]).toEqual(existing.hooks.SessionStart[0]);
    expect(s.hooks.Stop[1].hooks[0].command).toBe(`node "${path.join(pkg, 'dist', 'hooks', 'stop.js')}" # my-timesheet`);
    expect(hooksInstalled()).toBe(true);
  });

  it('uninstall restores the original settings exactly', () => {
    installHooks(pkg);
    uninstallHooks();
    expect(JSON.parse(fs.readFileSync(path.join(claudeDir(), 'settings.json'), 'utf8'))).toEqual(existing);
    expect(hooksInstalled()).toBe(false);
  });

  it('copies and removes the skill and command files', () => {
    const files = installSkillFiles(pkg);
    expect(files.every(f => fs.existsSync(f))).toBe(true);
    uninstallSkillFiles();
    expect(files.some(f => fs.existsSync(f))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/keychain.test.ts tests/install.test.ts`
Expected: FAIL. The modules can't be found.

- [ ] **Step 3: Write `src/lib/keychain.ts`**

```ts
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { paths } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';

export type SecretName = 'linear' | 'everhour';
export interface SecretStore { get(n: SecretName): string | null; set(n: SecretName, v: string): void; remove(n: SecretName): void }

const service = (n: SecretName) => `my-timesheet.${n}`;
const account = () => os.userInfo().username;

const keychain: SecretStore = {
  get(n) {
    try {
      return execFileSync('security', ['find-generic-password', '-s', service(n), '-a', account(), '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null;
    }
  },
  set(n, v) {
    execFileSync('security', ['add-generic-password', '-U', '-s', service(n), '-a', account(), '-w', v], { stdio: 'ignore' });
  },
  remove(n) {
    try { execFileSync('security', ['delete-generic-password', '-s', service(n), '-a', account()], { stdio: 'ignore' }); } catch { /* absent */ }
  },
};

const file: SecretStore = {
  get: n => readJson<Record<string, string>>(paths.secrets(), {})[n] ?? null,
  set(n, v) {
    const all = readJson<Record<string, string>>(paths.secrets(), {});
    all[n] = v;
    writeJsonAtomic(paths.secrets(), all, 0o600);
  },
  remove(n) {
    const all = readJson<Record<string, string>>(paths.secrets(), {});
    delete all[n];
    writeJsonAtomic(paths.secrets(), all, 0o600);
  },
};

export function secretStore(): SecretStore {
  return process.platform === 'darwin' && !process.env.TIMESHEET_SECRETS_FILE ? keychain : file;
}
```

- [ ] **Step 4: Write `src/lib/install.ts`**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './store.js';

export const HOOK_MARKER = '# my-timesheet';

export const claudeDir = (): string => process.env.TIMESHEET_CLAUDE_DIR ?? path.join(os.homedir(), '.claude');
const settingsFile = () => path.join(claudeDir(), 'settings.json');

/** dist/lib/install.js → package root */
export const packageRoot = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const hookCommand = (pkgRoot: string, name: 'session-start' | 'stop'): string =>
  `node "${path.join(pkgRoot, 'dist', 'hooks', `${name}.js`)}" ${HOOK_MARKER}`;

type HookEntry = { type?: string; command?: string; timeout?: number };
type Group = { matcher?: string; hooks?: HookEntry[] };
const isOurs = (h: HookEntry) => typeof h.command === 'string' && h.command.endsWith(HOOK_MARKER);

function stripOurs(groups: Group[] = []): Group[] {
  return groups
    .map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !isOurs(h)) }))
    .filter(g => (g.hooks ?? []).length > 0);
}

export function installHooks(pkgRoot: string): void {
  const s = readJson<Record<string, any>>(settingsFile(), {});
  s.hooks ??= {};
  for (const [event, name] of [['SessionStart', 'session-start'], ['Stop', 'stop']] as const) {
    const groups = stripOurs(s.hooks[event]);
    groups.push({ hooks: [{ type: 'command', command: hookCommand(pkgRoot, name), timeout: 5 }] });
    s.hooks[event] = groups;
  }
  writeJsonAtomic(settingsFile(), s);
}

export function uninstallHooks(): void {
  const s = readJson<Record<string, any>>(settingsFile(), {});
  if (!s.hooks) return;
  for (const event of ['SessionStart', 'Stop']) {
    const groups = stripOurs(s.hooks[event]);
    if (groups.length) s.hooks[event] = groups;
    else delete s.hooks[event];
  }
  if (Object.keys(s.hooks).length === 0) delete s.hooks;
  writeJsonAtomic(settingsFile(), s);
}

export function hooksInstalled(): boolean {
  const s = readJson<Record<string, any>>(settingsFile(), {});
  return ['SessionStart', 'Stop'].every(e => (s.hooks?.[e] ?? []).some((g: Group) => (g.hooks ?? []).some(isOurs)));
}

const skillTargets = (pkgRoot: string): [string, string][] => [
  [path.join(pkgRoot, 'skill', 'SKILL.md'), path.join(claudeDir(), 'skills', 'timesheet', 'SKILL.md')],
  [path.join(pkgRoot, 'skill', 'commands', 'timesheet.md'), path.join(claudeDir(), 'commands', 'timesheet.md')],
];

export function installSkillFiles(pkgRoot: string): string[] {
  for (const [src, dst] of skillTargets(pkgRoot)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return skillTargets(pkgRoot).map(([, dst]) => dst);
}

export function uninstallSkillFiles(): void {
  fs.rmSync(path.join(claudeDir(), 'skills', 'timesheet'), { recursive: true, force: true });
  fs.rmSync(path.join(claudeDir(), 'commands', 'timesheet.md'), { force: true });
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -- tests/keychain.test.ts tests/install.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/keychain.ts src/lib/install.ts tests/keychain.test.ts tests/install.test.ts
git commit -m "feat: keychain secrets and idempotent hook/skill installation"
```

---

### Task 14: The skill files and the `timesheet` CLI

**Files:**
- Create: `skill/SKILL.md`, `skill/commands/timesheet.md`
- Create: `src/cli/out.ts`, `src/cli/index.ts`
- Create: `src/cli/commands/init.ts`, `repo.ts`, `prepare.ts`, `ingest.ts`, `status.ts`, `review.ts`, `push.ts`, `doctor.ts`, `uninstall.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: Tasks 1–13, plus `startServer` from Task 15. `review.ts` imports it, so leave that import out until Task 15 lands and reinstate it in Task 15, Step 6.
- Produces:
  - Commands: `timesheet init | repo | prepare | ingest | status | review | push | doctor | uninstall`.
  - From `out.ts`: `step(label, fn, done?)`, `added(what, where)`, `ok(msg)`, `fail(msg)`, `fmtMs(ms)`, `weekSummary(d: Draft): string`.

`prepare` and `ingest` are internal subcommands that the skill calls. They're listed in `--help` under "internal".

- [ ] **Step 1: Write `skill/SKILL.md`**

```markdown
---
name: timesheet
description: Drafts the weekly my-timesheet worksheet (Linear parent issues and sub-issues) from this week's indexed Claude Code sessions and git commits. Use when the user runs /timesheet or asks to draft, update or redo their timesheet or worklog for a week.
---

# Drafting a my-timesheet week

You turn one week of work evidence into timesheet items. **You never decide hours.** The user types a weekly total in the review UI, and code splits it.

## Procedure

1. Run `timesheet prepare --week <this|last|YYYY-Www>` (default `this`). It prints the path to `context.json` and any warnings. Pass each warning to the user in one line.
2. Read `context.json`. It contains:
   - `week`, `days`, `countedDays`;
   - `projects` (name + kind `billable`/`internal`) and `internalProject`;
   - `sessions` (prompts, files edited, commands, replies, per-day activity);
   - `commits` (repo, day, subject, files, size);
   - `existing` (items already in the draft, with `id`, `edited`, `deleted` and `pushed` flags);
   - `examples` (past corrections by the user: project flips and rewrites). Follow them.
3. Write `proposal.json` **in the same folder as `context.json`**:
   ```json
   {
     "items": [
       { "id": "optional: only when updating an existing item",
         "title": "Prefill extract endpoint",
         "description": "Added POST /api/onboarding-prefill/extract with a 25 MB limit and MIME sniffing for PDF/PPTX. Reads deck and website in parallel and degrades to an empty form on failure.",
         "project": "Boxsy",
         "bucketReason": "client feature shipped in their app",
         "day": "2026-10-05",
         "evidence": { "commits": ["<sha>"], "sessions": ["<session id>"] } }
     ],
     "parents": [
       { "key": "2026-10-05|Boxsy", "title": "Monday — Prefill polish and QA", "description": "## 2026-10-05\n\nTwo to three sentence summary of the day's work in this project." }
     ]
   }
   ```
4. Run `timesheet ingest --week <same week>`. Relay its one-line summary. Then tell the user to run `/timesheet review` to edit the items, set the total and push.

## What an item is

- One sub-issue covers one coherent piece of work: a feature slice, an investigation, a doc, a QA pass, a review. Don't merge unrelated commits to keep the list short, and don't split a single change into many items.
- **Title:** 2–3 words, specific (e.g. "Website reader via Exa", not "Backend work").
- **Description:** 2–4 technical sentences about what was done and why. Name files, endpoints, models and findings. No filler.
- **Day:** the local date when most of that item's evidence happened.
- **Evidence:** list every commit SHA and session ID the item came from. This is how re-runs avoid duplicates, so be complete.
- Research and exploration from Claude sessions count as items even when there are no commits.
- **Never** mention hours, durations or time spent in any title or description.

## Billable vs internal

For each item, ask: **did the client ask for this, or will they see the output?** If yes, it's the repo's billable project. If no (exploration, experiments, tooling for us, research the client didn't ask for), it's `internalProject`. Always write a one-line `bucketReason`. When a repo has a mapped project in `context.repos`, that's the billable default for its items.

## Updating a week that already has items

- Only re-propose an existing item (with its `id`) if new evidence changes it. Leave out items you'd keep as they are; they stay in the draft.
- Never re-propose items whose `edited`, `deleted` or `pushed` is true. Never re-create work that a deleted item covered.
- New work is a new item with no `id`.

## Parents

For every (day, project) pair that has items, propose a parent:
- key `YYYY-MM-DD|Project`;
- title `<Weekday> — <theme>`;
- description `## YYYY-MM-DD` followed by a blank line and a 2–3 sentence summary.

Don't write the sub-task count; code adds it.
```

- [ ] **Step 2: Write `skill/commands/timesheet.md`**

```markdown
---
description: Draft, review or configure this week's timesheet (my-timesheet)
argument-hint: "[last | YYYY-Www | review | repo <work|personal|ignore> [--project NAME]]"
---

Arguments: $ARGUMENTS

- If the arguments start with `review`: run `timesheet review` as a background process (it starts a local server and opens the browser). Tell the user the URL it prints, in one line.
- If the arguments start with `repo`: run `timesheet $ARGUMENTS` in the current directory and report the result in one line.
- Otherwise: use the `timesheet` skill to draft the week. The week is `last` if the arguments contain `last`, a `YYYY-Www` value if one is given, and `this` otherwise.
```

- [ ] **Step 3: Write `src/cli/out.ts`**

```ts
import pc from 'picocolors';
import type { Draft } from '../lib/types.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const fmtMs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

export async function step<T>(label: string, fn: (update: (suffix: string) => void) => Promise<T>, done?: (r: T) => string): Promise<T> {
  const tty = !!process.stdout.isTTY;
  const start = performance.now();
  let suffix = '';
  let f = 0;
  const timer = tty
    ? setInterval(() => process.stdout.write(`\r${pc.cyan(FRAMES[f++ % FRAMES.length])} ${label} ${pc.dim(suffix)}\x1b[K`), 80)
    : null;
  const clear = () => { if (timer) clearInterval(timer); if (tty) process.stdout.write('\r\x1b[K'); };
  try {
    const r = await fn(s => { suffix = s; });
    clear();
    process.stdout.write(`${done ? done(r) : label} ${pc.dim(fmtMs(performance.now() - start))}\n`);
    return r;
  } catch (e) {
    clear();
    process.stdout.write(`${pc.red('✗')} ${label}\n`);
    throw e;
  }
}

export const added = (what: string, where: string): void => console.log(` ${pc.green('+')} ${what.padEnd(14)} ${pc.dim(where)}`);
export const ok = (msg: string): void => console.log(` ${pc.green('✓')} ${msg}`);
export const fail = (msg: string): void => console.error(`${pc.red('✗')} ${msg}`);

export function weekSummary(d: Draft): string {
  const live = d.items.filter(i => !i.deleted);
  const total = live.reduce((s, i) => s + (i.hours ?? 0), 0);
  const byProject = new Map<string, number>();
  for (const i of live) byProject.set(i.project ?? 'unassigned', (byProject.get(i.project ?? 'unassigned') ?? 0) + (i.hours ?? 0));
  const parts = [...byProject].map(([p, h]) => `${p.toLowerCase()} ${h.toFixed(1)}`);
  return [d.week, `${total.toFixed(1)}h`, ...parts, `${live.length} items`, d.pushed ? 'pushed' : 'not pushed'].join(' · ');
}
```

- [ ] **Step 4: Write the failing CLI tests**

These run the compiled CLI against a temp home.

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { tmpDir, tmpHome, testConfig } from './helpers.js';
import { saveConfig, loadRepos, saveDraft, emptyDraft } from '../src/lib/store.js';

const cli = (args: string[], cwd = process.cwd()) =>
  spawnSync('node', [path.resolve('dist/cli/index.js'), ...args], { cwd, env: { ...process.env }, encoding: 'utf8' });

describe('timesheet CLI', () => {
  beforeAll(() => { execSync('npm run build', { stdio: 'ignore' }); });
  beforeEach(() => { tmpHome(); });

  it('prints help and fails clearly before init', () => {
    expect(cli(['--help']).stdout).toMatch(/timesheet init/);
    const r = cli(['status']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/timesheet init/);
  });

  it('repo saves a classification for a folder with spaces and validates projects', () => {
    saveConfig(testConfig());
    const dir = path.join(tmpDir(), 'my side project');
    fs.mkdirSync(dir);
    expect(cli(['repo', 'work', '--path', dir, '--project', 'Nope']).stderr).toMatch(/Unknown project "Nope"/);
    expect(cli(['repo', 'work', '--path', dir, '--project', 'Boxsy']).status).toBe(0);
    expect(loadRepos()[dir]).toMatchObject({ class: 'work', project: 'Boxsy' });
    expect(cli(['repo', 'personal', '--path', dir]).status).toBe(0);
    expect(loadRepos()[dir]).toMatchObject({ class: 'personal' });
  });

  it('status prints the week summary', () => {
    saveConfig(testConfig());
    saveDraft(emptyDraft('2026-W41'));
    expect(cli(['status', '--week', '2026-W41']).stdout).toMatch(/2026-W41 · 0\.0h · 0 items · not pushed/);
  });
});
```

- [ ] **Step 5: Run the tests and confirm they fail**

Run: `npm test -- tests/cli.test.ts`
Expected: FAIL. The build fails or `dist/cli/index.js` is missing.

- [ ] **Step 6: Write `src/cli/index.ts`**

```ts
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import { fail } from './out.js';

const HELP = `timesheet — turn your week into Linear issues + Everhour time

  timesheet init                       set up keys, projects, orgs and hooks
  timesheet review [--week W]          open the review UI (default: this week)
  timesheet push [--week W]            push the week to Linear and Everhour
  timesheet status [--week W]          one-line summary of a week
  timesheet repo <work|personal|ignore> [--path P] [--project NAME]
  timesheet doctor                     check keys, hooks and tools
  timesheet uninstall [--purge]        remove hooks and command (--purge: data too)

  internal (used by /timesheet):
  timesheet prepare [--week W]         build context.json for Claude
  timesheet ingest [--week W]          merge proposal.json into the draft

  W = this | last | YYYY-Www`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      week: { type: 'string' },
      path: { type: 'string' },
      project: { type: 'string' },
      purge: { type: 'boolean' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) { console.log(HELP); return; }
  switch (cmd) {
    case 'init': return (await import('./commands/init.js')).init();
    case 'repo': return (await import('./commands/repo.js')).repo(rest, values);
    case 'prepare': return (await import('./commands/prepare.js')).prepareCmd(values.week);
    case 'ingest': return (await import('./commands/ingest.js')).ingestCmd(values.week);
    case 'status': return (await import('./commands/status.js')).status(values.week);
    case 'review': return (await import('./commands/review.js')).review(values.week, !values['no-open']);
    case 'push': return (await import('./commands/push.js')).pushCmd(values.week);
    case 'doctor': return (await import('./commands/doctor.js')).doctor();
    case 'uninstall': return (await import('./commands/uninstall.js')).uninstall(!!values.purge);
    default: throw new Error(`Unknown command "${cmd}". Run: timesheet --help`);
  }
}

main().catch(e => {
  fail((e as Error).message);
  if (process.env.TIMESHEET_DEBUG) console.error(pc.dim((e as Error).stack ?? ''));
  process.exit(1);
});
```

- [ ] **Step 7: Write the simple commands**

`src/cli/commands/repo.ts`:
```ts
import fs from 'node:fs';
import { realGit, slugFor } from '../../lib/repo.js';
import { loadRepos, requireConfig, saveRepos } from '../../lib/store.js';
import type { RepoClass } from '../../lib/types.js';
import { ok } from '../out.js';

export function repo(args: string[], values: { path?: string; project?: string }): void {
  const cls = args[0] as RepoClass;
  if (!['work', 'personal', 'ignore'].includes(cls)) throw new Error('Usage: timesheet repo <work|personal|ignore> [--path P] [--project NAME]');
  const config = requireConfig();
  const target = values.path ?? process.cwd();
  if (!fs.existsSync(target)) throw new Error(`No such folder: ${target}`);
  if (values.project && !config.projects.some(p => p.name === values.project)) {
    throw new Error(`Unknown project "${values.project}". Known: ${config.projects.map(p => p.name).join(', ')}`);
  }
  const root = realGit.root(target);
  const repos = loadRepos();
  const prev = repos[root];
  repos[root] = {
    class: cls,
    name: prev?.name ?? slugFor(root) ?? undefined,
    project: cls === 'work' ? values.project ?? prev?.project : undefined,
  };
  saveRepos(repos);
  ok(`${repos[root].name ?? root} → ${cls}${repos[root].project ? ` (${repos[root].project})` : ''}`);
}
```

`src/cli/commands/prepare.ts`:
```ts
import pc from 'picocolors';
import { prepare } from '../../lib/draftflow.js';
import { resolveWeek } from '../../lib/week.js';
import { step } from '../out.js';

export async function prepareCmd(weekArg?: string): Promise<void> {
  const week = resolveWeek(weekArg);
  const r = await step(`Collecting ${week}`, async () => prepare(week), x => `Collected ${x.sessions} sessions, ${x.commits} commits`);
  for (const w of r.warnings) console.log(`${pc.yellow('!')} ${w}`);
  console.log(r.contextPath);
}
```

`src/cli/commands/ingest.ts`:
```ts
import { ingest } from '../../lib/draftflow.js';
import { resolveWeek } from '../../lib/week.js';
import { step } from '../out.js';

export async function ingestCmd(weekArg?: string): Promise<void> {
  const week = resolveWeek(weekArg);
  await step(`Merging ${week}`, async () => ingest(week), r => `Merged ${r.added} new, ${r.updated} updated, ${r.skipped} skipped · ${r.items} items in ${week}`);
}
```

`src/cli/commands/status.ts`:
```ts
import { emptyDraft, loadDraft, requireConfig } from '../../lib/store.js';
import { resolveWeek } from '../../lib/week.js';
import { validate } from '../../lib/validate.js';
import { weekSummary } from '../out.js';

export function status(weekArg?: string): void {
  const config = requireConfig();
  const week = resolveWeek(weekArg);
  const d = loadDraft(week) ?? emptyDraft(week);
  console.log(weekSummary(d));
  const blocks = validate(d, config.projects.map(p => p.name)).filter(w => w.level === 'block');
  if (blocks.length) console.log(`${blocks.length} blocking issue${blocks.length === 1 ? '' : 's'} · run: timesheet review`);
}
```

`src/cli/commands/uninstall.ts`:
```ts
import fs from 'node:fs';
import { home } from '../../lib/paths.js';
import { uninstallHooks, uninstallSkillFiles } from '../../lib/install.js';
import { secretStore } from '../../lib/keychain.js';
import { ok } from '../out.js';

export function uninstall(purge: boolean): void {
  uninstallHooks();
  uninstallSkillFiles();
  ok('Removed hooks, skill and /timesheet command');
  if (purge) {
    secretStore().remove('linear');
    secretStore().remove('everhour');
    fs.rmSync(home(), { recursive: true, force: true });
    ok(`Deleted ${home()} and stored keys`);
  }
}
```

- [ ] **Step 8: Write `src/cli/commands/push.ts`**

```ts
import readline from 'node:readline/promises';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { loadDraft, requireConfig, saveDraft } from '../../lib/store.js';
import { resolveWeek, weekDays } from '../../lib/week.js';
import { secretStore } from '../../lib/keychain.js';
import { Linear } from '../../lib/linear.js';
import { Everhour } from '../../lib/everhour.js';
import { push, type PushEvent } from '../../lib/push.js';
import { fail, ok, step, weekSummary } from '../out.js';

export function clientsFromSecrets() {
  const s = secretStore();
  const lk = s.get('linear');
  const ek = s.get('everhour');
  if (!lk || !ek) throw new Error('API keys missing. Run: timesheet init');
  return { linear: new Linear(lk), everhour: new Everhour(ek) };
}

const LABEL: Record<PushEvent['phase'], string> = { parents: 'Linear parents', issues: 'Linear sub-issues', sync: 'Everhour tasks', time: 'Logging time' };

export async function pushCmd(weekArg?: string): Promise<void> {
  const config = requireConfig();
  const week = resolveWeek(weekArg);
  const draft = loadDraft(week);
  if (!draft) throw new Error(`No draft for ${week}. Run /timesheet in Claude first.`);
  const { linear, everhour } = clientsFromSecrets();
  const days = weekDays(week);
  const already = (await everhour.userSeconds(config.everhour.userId, days[0], days[6])) / 3600;
  if (already > 0 && !draft.pushed) {
    const go = await p.confirm({ message: `Everhour already has ${already.toFixed(1)}h for you in ${week}. Push anyway?`, initialValue: false });
    if (p.isCancel(go) || !go) return;
  }
  for (;;) {
    let update: (s: string) => void = () => {};
    let current: PushEvent['phase'] | null = null;
    const result = await step('Pushing', async u => {
      update = u;
      return push(draft, {
        linear, everhour, config, save: saveDraft,
        onProgress: e => { if (e.phase !== current) current = e.phase; update(`${LABEL[e.phase]} ${e.done}/${e.total}`); },
      });
    }, r => (r.status === 'done' ? `Pushed ${r.issues} sub-issues, ${r.hours.toFixed(1)}h` : `Paused: ${r.status.replace('_', ' ')}`));
    if (result.status === 'blocked') {
      for (const w of result.warnings) fail(w.message);
      throw new Error('Fix these in: timesheet review');
    }
    if (result.status === 'awaiting_sync') {
      console.log(`${pc.yellow('!')} ${result.missing.length} issues aren't in Everhour yet:`);
      for (const m of result.missing.slice(0, 8)) console.log(`   ${m.identifier}  ${pc.dim(m.project)}`);
      const projects = [...new Set(result.missing.map(m => m.project))].join(', ');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await rl.question(`  Open Everhour → Projects → ${projects} → Sync, then press Enter `);
      rl.close();
      continue;
    }
    ok(weekSummary(draft));
    return;
  }
}
```

- [ ] **Step 9: Write `src/cli/commands/init.ts`**

```ts
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { Linear } from '../../lib/linear.js';
import { Everhour } from '../../lib/everhour.js';
import { secretStore } from '../../lib/keychain.js';
import { loadConfig, saveConfig } from '../../lib/store.js';
import { installHooks, installSkillFiles, packageRoot } from '../../lib/install.js';
import type { Config, ProjectConfig } from '../../lib/types.js';
import { added, step } from '../out.js';

const bail = <T>(v: T | symbol): T => {
  if (p.isCancel(v)) { p.cancel('Cancelled'); process.exit(1); }
  return v as T;
};

function stablePackageRoot(): string {
  const here = packageRoot();
  if (!here.includes(`${path.sep}_npx${path.sep}`)) return here;
  execFileSync('npm', ['install', '-g', 'my-timesheet'], { stdio: 'inherit' });
  return path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'my-timesheet');
}

export async function init(): Promise<void> {
  p.intro(pc.inverse(' my-timesheet '));
  const prev = loadConfig();
  const pkgRoot = await step('Installing timesheet', async () => stablePackageRoot(), r => `${pc.green('◇')} Installed  ${pc.dim(r)}`);

  const linearKey = bail(await p.password({ message: 'Linear personal API key (Linear → Settings → Security & access → API keys)' }));
  const linear = new Linear(linearKey);
  const me = await step('Linear', () => linear.viewer(), v => `${pc.green('◇')} Linear  ✓ ${v.email}`);
  const all = await linear.projects();
  const chosenIds = bail(await p.multiselect({
    message: 'Which projects do you log time to?',
    options: all.map(pr => ({ value: pr.id, label: pr.name, hint: pr.teams.map(t => t.key).join(',') })),
    initialValues: prev?.projects.map(x => x.id) ?? [],
    required: true,
  })) as string[];
  const chosen = all.filter(pr => chosenIds.includes(pr.id));
  const internalId = bail(await p.select({
    message: 'Which one is internal (not billable)?',
    options: chosen.map(pr => ({ value: pr.id, label: pr.name })),
    initialValue: chosen.find(pr => /internal/i.test(pr.name))?.id,
  })) as string;
  const statusName = bail(await p.text({ message: 'Status for created issues', initialValue: 'Done' }));
  const projects: ProjectConfig[] = [];
  for (const pr of chosen) {
    const team = pr.teams[0];
    if (!team) throw new Error(`Project ${pr.name} has no team.`);
    const states = await linear.states(team.id);
    const st = states.find(s => s.name.toLowerCase() === statusName.toLowerCase());
    if (!st) throw new Error(`Team ${team.name} has no status "${statusName}". Available: ${states.map(s => s.name).join(', ')}`);
    projects.push({ id: pr.id, name: pr.name, teamId: team.id, kind: pr.id === internalId ? 'internal' : 'billable', stateId: st.id, labelIds: [] });
  }

  const everhourKey = bail(await p.password({ message: 'Everhour API key (Everhour → Settings → Profile → API)' }));
  const eh = await step('Everhour', () => new Everhour(everhourKey).me(), v => `${pc.green('◇')} Everhour  ✓ user ${v.id}${v.linearConnected ? ' · linear integration active' : pc.yellow(' · Linear integration not detected')}`);

  let orgs: string[] = [];
  try { orgs = execFileSync('gh', ['api', 'user/orgs', '--jq', '.[].login'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* gh missing */ }
  const workOrgs = orgs.length
    ? bail(await p.multiselect({ message: 'Which GitHub orgs are work?', options: orgs.map(o => ({ value: o, label: o })), initialValues: prev?.workOrgs ?? [], required: false })) as string[]
    : bail(await p.text({ message: 'Work GitHub orgs (comma-separated)', initialValue: prev?.workOrgs.join(',') ?? '' })).split(',').map(s => s.trim()).filter(Boolean);

  const nudge = bail(await p.confirm({ message: 'Remind you on Sunday evening if the week is not pushed?', initialValue: prev?.nudge ?? false }));

  let gitEmail = '';
  try { gitEmail = execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8' }).trim(); } catch { /* none */ }

  const config: Config = {
    version: 1,
    linear: { assigneeId: me.id, assigneeEmail: me.email },
    everhour: { userId: eh.id },
    projects,
    internalProject: projects.find(x => x.kind === 'internal')!.name,
    workOrgs,
    gitEmails: [...new Set([gitEmail, me.email].filter(Boolean))],
    nudge,
    port: prev?.port ?? 4747,
  };
  const secrets = secretStore();
  secrets.set('linear', linearKey);
  secrets.set('everhour', everhourKey);
  saveConfig(config);

  const t0 = performance.now();
  installHooks(pkgRoot);
  const files = installSkillFiles(pkgRoot);
  console.log(`Installed 2 hooks, 1 skill, 1 command in ${Math.round(performance.now() - t0)}ms`);
  added('SessionStart', '~/.claude/settings.json');
  added('Stop', '~/.claude/settings.json');
  for (const f of files) added(path.basename(path.dirname(f)) === 'commands' ? '/timesheet' : 'skill', f);
  p.outro('Ready. Work as usual; on Sunday run /timesheet in Claude.');
}
```

- [ ] **Step 10: Write `src/cli/commands/doctor.ts`**

```ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../../lib/store.js';
import { secretStore } from '../../lib/keychain.js';
import { claudeDir, hooksInstalled } from '../../lib/install.js';
import { Linear } from '../../lib/linear.js';
import { Everhour } from '../../lib/everhour.js';

const line = (good: boolean, msg: string) => console.log(` ${good ? pc.green('✓') : pc.red('✗')} ${msg}`);
const has = (cmd: string) => { try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };

export async function doctor(): Promise<void> {
  const config = loadConfig();
  line(!!config, config ? 'config found' : 'no config, run: timesheet init');
  const s = secretStore();
  const lk = s.get('linear');
  const ek = s.get('everhour');
  try { const v = lk ? await new Linear(lk).viewer() : null; line(!!v, v ? `Linear key works (${v.email})` : 'Linear key missing'); }
  catch (e) { line(false, `Linear key rejected: ${(e as Error).message}`); }
  try { const v = ek ? await new Everhour(ek).me() : null; line(!!v && v.linearConnected, v ? `Everhour key works (user ${v.id})${v.linearConnected ? '' : ', Linear integration not detected'}` : 'Everhour key missing'); }
  catch (e) { line(false, `Everhour key rejected: ${(e as Error).message}`); }
  line(hooksInstalled(), 'hooks installed in ~/.claude/settings.json');
  line(fs.existsSync(path.join(claudeDir(), 'commands', 'timesheet.md')), '/timesheet command installed');
  line(has('claude'), 'claude CLI available (for weights)');
  line(has('gh'), 'gh CLI available (for work orgs)');
}
```

- [ ] **Step 11: Write a temporary `src/cli/commands/review.ts` (replaced in Task 15)**

```ts
export async function review(_week?: string, _open = true): Promise<void> {
  throw new Error('The review UI arrives in the next task.');
}
```

- [ ] **Step 12: Run the build and tests**

Run: `npm run build && npm test`
Expected: PASS. The CLI tests are green.

- [ ] **Step 13: Commit**

```bash
git add skill src/cli tests/cli.test.ts
git commit -m "feat: timesheet CLI, /timesheet command and drafting skill"
```

---

### Task 15: Local review server (`server.ts`)

**Files:**
- Create: `src/server/server.ts`
- Modify: `src/cli/commands/review.ts` (replace the temporary version)
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes:
  - store functions, `validate`, `syncParents`, `runDistribute`/`runClaude`, `setHours`/`splitItem`/`mechanicalSplit`/`mergeItems`/`addManualItem`/`deleteItem`, `push`;
  - `clientsFromSecrets` (Task 14, `push.ts`); `appendLine`, `paths`, `listWeeks`, `weekDays`.
- Produces:
  - `startServer(port: number, deps?: ServerDeps): Promise<{ url: string; server: http.Server; close(): Promise<void> }>`
  - `interface ServerDeps { run?: ClaudeRunner; clients?: () => { linear: LinearApi; everhour: EverhourApi & { userSeconds(id: number, from: string, to: string): Promise<number> } }; now?: () => Date }`
  - **HTTP API** (JSON; `?week=` defaults to the current week):

    | Method | Path | Body | Returns |
    |---|---|---|---|
    | GET | `/api/state` | | `{week, draft, weeks, projects: {name, kind}[], warnings, push}` |
    | GET | `/api/rev` | | `{rev}` |
    | PUT | `/api/draft` | `{draft}` | `{draft, warnings}` or **409** `{error, draft}` when the rev is stale |
    | POST | `/api/distribute` | `{week, reweight}` | `{draft, warnings}` |
    | POST | `/api/hours` | `{week, id, hours}` | `{draft, warnings}` |
    | POST | `/api/items` | `{week, title, description, project, day}` | `{draft, warnings}` |
    | POST | `/api/delete` | `{week, id}` | `{draft, warnings}` |
    | POST | `/api/split` | `{week, id, parts}` | `{draft, warnings}` |
    | POST | `/api/merge` | `{week, ids}` | `{draft, warnings}` |
    | GET | `/api/everhour` | | `{hours: number \| null}` |
    | GET | `/api/history` | | `[{week, total, items, pushed}]` |
    | GET / PUT | `/api/settings` | | `{projects: {name, kind}[], workOrgs, nudge, repos: {root, class, project, name}[]}` |
    | POST | `/api/push` | `{week}` | **202** |
    | GET | `/api/push` | | `PushState` |

**Rules the server enforces on PUT:**
- Pushed items in the incoming draft are replaced by the stored versions.
- When an item's `project` changed, a `{kind: 'bucket'}` example is appended to `examples.jsonl`.
- When its title or description changed, a `{kind: 'rewrite'}` example is appended and `edited = true` is set.
- `syncParents` runs before saving.

- [ ] **Step 1: Write the failing tests (covers Review Focus #4 and #5)**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { tmpHome, testConfig, makeItem, makeDraft } from './helpers.js';
import { FakeLinear, FakeEverhour } from './fakes.js';
import { saveConfig, saveDraft, readJsonl, loadDraft } from '../src/lib/store.js';
import { syncParents } from '../src/lib/parents.js';
import { paths } from '../src/lib/paths.js';
import { startServer } from '../src/server/server.js';

const W = '2026-W41';
let srv: Awaited<ReturnType<typeof startServer>>;
const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(srv.url + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};

describe('review server', () => {
  let everhour: FakeEverhour;
  beforeEach(async () => {
    tmpHome();
    saveConfig(testConfig());
    saveDraft(syncParents(makeDraft({ week: W, rev: 0, items: [makeItem({ id: 'a', weight: 3 }), makeItem({ id: 'b', weight: 1 })] })));
    everhour = new FakeEverhour();
    srv = await startServer(0, {
      run: async () => '[{"id":"a","weight":3,"reason":"x"},{"id":"b","weight":1,"reason":"y"}]',
      clients: () => ({ linear: new FakeLinear(), everhour }),
      now: () => new Date('2026-10-06T10:00:00Z'),
    });
  });
  afterEach(async () => { await srv.close(); });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const port = new URL(srv.url).port;
    const status = await new Promise<number>(res => {
      http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example' } }, r => res(r.statusCode!));
    });
    expect(status).toBe(403);
  });

  it('serves state and returns 409 for a stale rev', async () => {
    const s = await api('GET', `/api/state?week=${W}`);
    expect(s.json.draft.items).toHaveLength(2);
    const stale = { ...s.json.draft, rev: s.json.draft.rev - 1 };
    const r = await api('PUT', '/api/draft', { draft: stale });
    expect(r.status).toBe(409);
    expect(r.json.draft.rev).toBe(s.json.draft.rev);
  });

  it('records bucket flips and rewrites as examples and marks edits', async () => {
    const { json } = await api('GET', `/api/state?week=${W}`);
    json.draft.items[0].project = 'Dev - Internal';
    json.draft.items[1].title = 'Better title';
    const r = await api('PUT', '/api/draft', { draft: json.draft });
    expect(r.status).toBe(200);
    expect(r.json.draft.items[1].edited).toBe(true);
    expect(readJsonl<any>(paths.examples()).map(e => e.kind).sort()).toEqual(['bucket', 'rewrite']);
  });

  it('refuses to change pushed items through PUT', async () => {
    const d = loadDraft(W)!;
    d.items[0].linear = { uuid: 'u', identifier: 'T-1', url: null, created: true };
    d.items[0].title = 'Pushed title';
    saveDraft(d);
    const { json } = await api('GET', `/api/state?week=${W}`);
    json.draft.items[0].title = 'Sneaky change';
    const r = await api('PUT', '/api/draft', { draft: json.draft });
    expect(r.json.draft.items[0].title).toBe('Pushed title');
  });

  it('distributes and reports clear errors for bad totals', async () => {
    let { json } = await api('GET', `/api/state?week=${W}`);
    json.draft.totalHours = 4;
    await api('PUT', '/api/draft', { draft: json.draft });
    const r = await api('POST', '/api/distribute', { week: W, reweight: false });
    expect(r.json.draft.items.map((i: any) => i.hours)).toEqual([3, 1]);
    json = (await api('GET', `/api/state?week=${W}`)).json;
    json.draft.totalHours = 3.3;
    await api('PUT', '/api/draft', { draft: json.draft });
    const bad = await api('POST', '/api/distribute', { week: W, reweight: false });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/multiple of 0.5h/);
  });

  it('runs a push in the background and reports awaiting_sync then done', async () => {
    let { json } = await api('GET', `/api/state?week=${W}`);
    json.draft.totalHours = 4;
    await api('PUT', '/api/draft', { draft: json.draft });
    await api('POST', '/api/distribute', { week: W, reweight: false });
    everhour.autoSync = false;
    expect((await api('POST', '/api/push', { week: W })).status).toBe(202);
    const waitFor = async (want: string) => {
      for (let i = 0; i < 50; i++) { const s = await api('GET', `/api/push?week=${W}`); if (s.json.status === want) return s.json; await new Promise(r => setTimeout(r, 20)); }
      throw new Error(`never reached ${want}`);
    };
    await waitFor('awaiting_sync');
    everhour.autoSync = true;
    await api('POST', '/api/push', { week: W });
    await waitFor('done');
    expect(loadDraft(W)!.pushed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -- tests/server.test.ts`
Expected: FAIL. The module can't be found.

- [ ] **Step 3: Write `src/server/server.ts`**

```ts
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../lib/paths.js';
import { appendLine, emptyDraft, listWeeks, loadDraft, loadRepos, readJson, requireConfig, saveConfig, saveDraft, saveRepos } from '../lib/store.js';
import { resolveWeek, weekDays } from '../lib/week.js';
import { validate } from '../lib/validate.js';
import { syncParents } from '../lib/parents.js';
import { runClaude, runDistribute, type ClaudeRunner } from '../lib/weights.js';
import { addManualItem, deleteItem, mechanicalSplit, mergeItems, setHours, splitItem } from '../lib/edit.js';
import { push } from '../lib/push.js';
import type { LinearApi } from '../lib/linear.js';
import type { EverhourApi } from '../lib/everhour.js';
import type { Draft, RepoClass, Warning, WeekEvidence } from '../lib/types.js';
import { clientsFromSecrets } from '../cli/commands/push.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

type Clients = { linear: LinearApi; everhour: EverhourApi & { userSeconds(id: number, from: string, to: string): Promise<number> } };
export interface ServerDeps { run?: ClaudeRunner; clients?: () => Clients; now?: () => Date }
type PushState = { status: 'idle' | 'running' | 'blocked' | 'awaiting_sync' | 'done' | 'error'; phase?: string; done?: number; total?: number; missing?: { identifier: string; project: string }[]; warnings?: Warning[]; error?: string };

class ApiError extends Error {
  constructor(public status: number, message: string, public payload: Record<string, unknown> = {}) { super(message); }
}

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new ApiError(413, 'Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new ApiError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export function createServer(deps: ServerDeps = {}): http.Server {
  const run = deps.run ?? runClaude;
  const clients = deps.clients ?? clientsFromSecrets;
  const now = deps.now ?? (() => new Date());
  const pushStates = new Map<string, PushState>();
  const ehCache = new Map<string, { at: number; hours: number | null }>();

  const projectNames = () => requireConfig().projects.map(p => p.name);
  const current = (week: string): Draft => loadDraft(week) ?? emptyDraft(week);
  const respond = (d: Draft) => ({ draft: d, warnings: validate(d, projectNames()) });
  const commit = (d: Draft) => respond(saveDraft(syncParents(d)));
  const wrap = <T>(fn: () => T): T => { try { return fn(); } catch (e) { throw e instanceof ApiError ? e : new ApiError(400, (e as Error).message); } };

  function putDraft(incoming: Draft) {
    if (!incoming?.week) throw new ApiError(400, 'Missing draft');
    const cur = current(incoming.week);
    if (incoming.rev !== cur.rev) throw new ApiError(409, 'The draft changed elsewhere. Reloaded.', { draft: cur });
    const before = new Map(cur.items.map(i => [i.id, i]));
    incoming.items = incoming.items.map(i => {
      const old = before.get(i.id);
      if (!old) return i;
      if (old.linear?.created) return old;
      if (old.project !== i.project) appendLine(paths.examples(), { kind: 'bucket', title: i.title, description: i.description, from: old.project, to: i.project, at: new Date().toISOString() });
      if (old.title !== i.title || old.description !== i.description) {
        appendLine(paths.examples(), { kind: 'rewrite', before: { title: old.title, description: old.description }, after: { title: i.title, description: i.description }, at: new Date().toISOString() });
        i.edited = true;
      }
      return i;
    });
    for (const p of incoming.parents) {
      const old = cur.parents.find(x => x.key === p.key);
      if (old?.linear?.created) Object.assign(p, old);
      else if (old && (old.title !== p.title || old.description !== p.description)) p.edited = true;
    }
    return commit(incoming);
  }

  async function everhourHours(week: string): Promise<number | null> {
    const hit = ehCache.get(week);
    if (hit && Date.now() - hit.at < 60_000) return hit.hours;
    let hours: number | null = null;
    try {
      const days = weekDays(week);
      hours = (await clients().everhour.userSeconds(requireConfig().everhour.userId, days[0], days[6])) / 3600;
    } catch { hours = null; }
    ehCache.set(week, { at: Date.now(), hours });
    return hours;
  }

  function startPush(week: string) {
    if (pushStates.get(week)?.status === 'running') throw new ApiError(409, 'A push is already running.');
    pushStates.set(week, { status: 'running', phase: 'parents', done: 0, total: 0 });
    void (async () => {
      try {
        const draft = loadDraft(week);
        if (!draft) throw new Error('No draft for this week.');
        const { linear, everhour } = clients();
        const r = await push(draft, { linear, everhour, config: requireConfig(), save: saveDraft, onProgress: e => pushStates.set(week, { status: 'running', ...e }) });
        if (r.status === 'done') pushStates.set(week, { status: 'done' });
        else if (r.status === 'blocked') pushStates.set(week, { status: 'blocked', warnings: r.warnings });
        else pushStates.set(week, { status: 'awaiting_sync', missing: r.missing });
        ehCache.delete(week);
      } catch (e) {
        pushStates.set(week, { status: 'error', error: (e as Error).message });
      }
    })();
  }

  const server = http.createServer(async (req, res) => {
    try {
      const port = (server.address() as { port: number }).port;
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'Forbidden host' });
      const url = new URL(req.url ?? '/', 'http://local');
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(PUBLIC, file)));
      }
      const week = resolveWeek(url.searchParams.get('week') ?? undefined, now());
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /api/state': {
          const config = requireConfig();
          const d = current(week);
          return send(res, 200, {
            week, draft: d, weeks: [...new Set([week, ...listWeeks()])].sort().reverse(),
            projects: config.projects.map(({ name, kind }) => ({ name, kind })),
            warnings: validate(d, projectNames()), push: pushStates.get(week) ?? { status: 'idle' },
          });
        }
        case 'GET /api/rev': return send(res, 200, { rev: loadDraft(week)?.rev ?? 0 });
        case 'PUT /api/draft': { const b = await readBody(req); return send(res, 200, wrap(() => putDraft(b.draft))); }
        case 'POST /api/distribute': {
          const b = await readBody(req);
          const w = resolveWeek(b.week, now());
          const evidence = readJson<WeekEvidence>(paths.evidence(w), { commits: {}, sessions: {} });
          let out: Draft;
          try { out = await runDistribute(current(w), { reweight: !!b.reweight }, { run, evidence }); } catch (e) { throw new ApiError(400, (e as Error).message); }
          return send(res, 200, commit(out));
        }
        case 'POST /api/hours': { const b = await readBody(req); return send(res, 200, wrap(() => commit(setHours(current(resolveWeek(b.week, now())), b.id, Number(b.hours))))); }
        case 'POST /api/items': { const b = await readBody(req); return send(res, 200, wrap(() => commit(addManualItem(current(resolveWeek(b.week, now())), b)))); }
        case 'POST /api/delete': { const b = await readBody(req); return send(res, 200, wrap(() => commit(deleteItem(current(resolveWeek(b.week, now())), b.id)))); }
        case 'POST /api/split': {
          const b = await readBody(req);
          return send(res, 200, wrap(() => {
            const d = current(resolveWeek(b.week, now()));
            const item = d.items.find(i => i.id === b.id);
            if (!item) throw new Error(`No item ${b.id}.`);
            return commit(splitItem(d, b.id, mechanicalSplit(item, Math.max(2, Number(b.parts) || 2))));
          }));
        }
        case 'POST /api/merge': { const b = await readBody(req); return send(res, 200, wrap(() => commit(mergeItems(current(resolveWeek(b.week, now())), b.ids)))); }
        case 'GET /api/everhour': return send(res, 200, { hours: await everhourHours(week) });
        case 'GET /api/history': return send(res, 200, listWeeks().map(w => {
          const d = loadDraft(w)!;
          const live = d.items.filter(i => !i.deleted);
          return { week: w, total: live.reduce((s, i) => s + (i.hours ?? 0), 0), items: live.length, pushed: d.pushed };
        }));
        case 'GET /api/settings': {
          const c = requireConfig();
          return send(res, 200, {
            projects: c.projects.map(({ name, kind }) => ({ name, kind })), workOrgs: c.workOrgs, nudge: c.nudge,
            repos: Object.entries(loadRepos()).map(([root, e]) => ({ root, ...e })),
          });
        }
        case 'PUT /api/settings': {
          const b = await readBody(req);
          const c = requireConfig();
          for (const p of c.projects) { const k = b.projects?.find((x: { name: string }) => x.name === p.name)?.kind; if (k === 'billable' || k === 'internal') p.kind = k; }
          if (Array.isArray(b.workOrgs)) c.workOrgs = b.workOrgs.map(String);
          if (typeof b.nudge === 'boolean') c.nudge = b.nudge;
          saveConfig(c);
          if (Array.isArray(b.repos)) {
            const repos = loadRepos();
            for (const r of b.repos as { root: string; class: RepoClass; project?: string }[]) {
              if (!repos[r.root] || !['work', 'personal', 'ignore'].includes(r.class)) continue;
              repos[r.root] = { ...repos[r.root], class: r.class, project: r.class === 'work' ? r.project : undefined };
            }
            saveRepos(repos);
          }
          return send(res, 200, { ok: true });
        }
        case 'POST /api/push': { const b = await readBody(req); startPush(resolveWeek(b.week, now())); return send(res, 202, { started: true }); }
        case 'GET /api/push': return send(res, 200, pushStates.get(week) ?? { status: 'idle' });
        default: return send(res, 404, { error: 'Not found' });
      }
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, (e as Error).message);
      send(res, err.status, { error: err.message, ...err.payload });
    }
  });
  return server;
}

export function startServer(port: number, deps: ServerDeps = {}): Promise<{ url: string; server: http.Server; close(): Promise<void> }> {
  const server = createServer(deps);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${p}`, server, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}
```

- [ ] **Step 4: Run the server tests and confirm they pass**

Run: `npm test -- tests/server.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Replace `src/cli/commands/review.ts`**

```ts
import { execFile } from 'node:child_process';
import { requireConfig } from '../../lib/store.js';
import { resolveWeek } from '../../lib/week.js';
import { startServer } from '../../server/server.js';
import { ok } from '../out.js';

export async function review(weekArg?: string, open = true): Promise<void> {
  const config = requireConfig();
  const week = resolveWeek(weekArg);
  let s;
  try {
    s = await startServer(config.port);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    s = { url: `http://127.0.0.1:${config.port}` };
    ok(`Review UI already running`);
  }
  const url = `${s.url}/?week=${week}`;
  ok(`Review ${week} at ${url}  (Ctrl+C to stop)`);
  if (open) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
}
```

- [ ] **Step 6: Build, run all tests, and commit**

Run: `npm run build && npm test`
Expected: PASS.

```bash
git add src/server/server.ts src/cli/commands/review.ts tests/server.test.ts
git commit -m "feat: loopback review server with conflict-safe edits and background push"
```

---

### Task 16: The review UI (terminal aesthetic)

**Files:**
- Create: `src/server/public/index.html`, `src/server/public/app.js`, `src/server/public/styles.css`
- Delete: `src/server/public/.keep`

**Interfaces:**
- Consumes: the HTTP API from Task 15 (the table in its Interfaces block).
- Produces: the review page served at `/`.

- [ ] **Step 1: Load the design skills before writing any UI code**

Invoke these skills, in this order, and follow their guidance for typography, colour tokens and spacing:
- `frontend-design:frontend-design`
- `ui-ux-pro-max:design`
- `ui-ux-pro-max:brand`

The behaviour and structure below are fixed. The skills refine the visual layer (`styles.css`) only, within the spec §7 constraints:
- monospace only (JetBrains Mono via Google Fonts, falling back to `ui-monospace`) with tabular numbers;
- near-black background, off-white text, grey for secondary text, one accent (phosphor green `#7CFF6B` or amber `#FFB000`), red only for blocking warnings;
- no gradients, shadows or rounded cards; box-drawing dividers;
- a tmux-style status bar; a light mode that inverts the colours.

- [ ] **Step 2: Write `src/server/public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>timesheet</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header id="top">
    <nav id="tabs"><button data-tab="week">week</button><button data-tab="settings">settings</button><button data-tab="history">history</button></nav>
    <div id="weekbar">
      <button id="prev" title="previous week">◂</button><span id="weeklabel"></span><button id="next" title="next week">▸</button>
      <span id="days"></span>
      <label>total <input id="total" inputmode="decimal" size="5" aria-label="total hours"></label>
      <button id="distribute" class="accent">distribute</button>
      <button id="reweight">re-weight</button>
      <span id="everhour" class="dim"></span>
    </div>
    <div id="warnings"></div>
  </header>
  <main id="view"></main>
  <section id="pushpanel" hidden></section>
  <div id="palette" hidden><input id="paletteinput" placeholder="distribute · reweight · push · week 2026-W40 · settings · history"></div>
  <div id="help" hidden></div>
  <footer id="status"></footer>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `src/server/public/app.js`**

```js
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = d => WEEKDAY[new Date(`${d}T12:00:00`).getDay()];

const state = {
  week: new URLSearchParams(location.search).get('week'),
  draft: null, base: null, weeks: [], projects: [], warnings: [], push: { status: 'idle' },
  tab: 'week', focus: 0, editing: null, mergeFrom: null, armedDelete: null, everhour: null, saving: false, flash: '',
};

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status, body: j });
  return j;
}

function flash(msg) { state.flash = msg; renderStatus(); setTimeout(() => { if (state.flash === msg) { state.flash = ''; renderStatus(); } }, 4000); }

function accept(res) {
  state.draft = res.draft;
  state.base = structuredClone(res.draft);
  state.warnings = res.warnings;
  render();
}

async function load(week) {
  const s = await api('GET', `/api/state${week ? `?week=${week}` : ''}`);
  state.week = s.week; state.weeks = s.weeks; state.projects = s.projects; state.push = s.push;
  history.replaceState(null, '', `?week=${s.week}`);
  accept(s);
  api('GET', `/api/everhour?week=${s.week}`).then(r => { state.everhour = r.hours; renderHeader(); }).catch(() => {});
}

const FIELDS = ['title', 'description', 'project', 'day', 'locked'];
function pendingPatches() {
  const base = new Map(state.base.items.map(i => [i.id, i]));
  const out = [];
  for (const i of state.draft.items) {
    const b = base.get(i.id);
    if (!b) continue;
    const patch = {};
    for (const f of FIELDS) if (JSON.stringify(i[f]) !== JSON.stringify(b[f])) patch[f] = i[f];
    if (Object.keys(patch).length) out.push([i.id, patch]);
  }
  const top = {};
  if (state.draft.totalHours !== state.base.totalHours) top.totalHours = state.draft.totalHours;
  if (JSON.stringify(state.draft.days) !== JSON.stringify(state.base.days)) top.days = state.draft.days;
  return { items: out, top };
}

let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); renderStatus(); }

async function save() {
  const pending = pendingPatches();
  if (!pending.items.length && !Object.keys(pending.top).length) return;
  state.saving = true; renderStatus();
  try {
    accept(await api('PUT', '/api/draft', { draft: state.draft }));
  } catch (e) {
    if (e.status === 409) {
      const fresh = e.body.draft;
      for (const [id, patch] of pending.items) { const it = fresh.items.find(x => x.id === id); if (it && !it.linear?.created) Object.assign(it, patch); }
      Object.assign(fresh, pending.top);
      state.base = structuredClone(e.body.draft);
      state.draft = fresh;
      flash('draft changed elsewhere, your edits were re-applied');
      return save();
    }
    flash(e.message);
  } finally { state.saving = false; renderStatus(); }
}

async function act(url, body) {
  await save();
  try { accept(await api('POST', url, { week: state.week, ...body })); } catch (e) { flash(e.message); }
}

const live = () => state.draft.items.filter(i => !i.deleted);
function rows() {
  const out = [];
  for (const day of [...state.draft.days].sort()) {
    out.push({ kind: 'day', day });
    const its = live().filter(i => i.day === day);
    for (const project of [...new Set(its.map(i => i.project ?? ''))]) {
      const parent = state.draft.parents.find(p => p.key === `${day}|${project}`);
      out.push({ kind: 'parent', day, project, parent });
      for (const item of its.filter(i => (i.project ?? '') === project)) out.push({ kind: 'item', item });
    }
  }
  const stray = live().filter(i => !state.draft.days.includes(i.day));
  if (stray.length) { out.push({ kind: 'day', day: 'not counted' }); for (const item of stray) out.push({ kind: 'item', item }); }
  return out;
}
const itemRows = () => rows().filter(r => r.kind === 'item');
const focused = () => itemRows()[state.focus]?.item;

function renderHeader() {
  $('#weeklabel').textContent = state.week;
  $('#total').value = state.draft.totalHours ?? '';
  const all = (() => { const [y, w] = state.week.split('-W').map(Number); const j4 = new Date(Date.UTC(y, 0, 4)); const mon = new Date(j4); mon.setUTCDate(j4.getUTCDate() - ((j4.getUTCDay() + 6) % 7) + (w - 1) * 7); return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setUTCDate(mon.getUTCDate() + i); return d.toISOString().slice(0, 10); }); })();
  $('#days').innerHTML = all.map(d => `<button class="day ${state.draft.days.includes(d) ? 'on' : ''}" data-day="${d}">${dayName(d)[0]}</button>`).join('');
  $('#everhour').textContent = state.everhour == null ? '' : `already in everhour: ${state.everhour.toFixed(1)}h`;
  $('#warnings').innerHTML = state.warnings.map(w => `<div class="warn ${w.level}">${w.level === 'block' ? '✗' : '!'} ${esc(w.message)}</div>`).join('');
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
}

function renderWeek() {
  const fid = focused()?.id;
  const loadByDay = d => live().filter(i => i.day === d).reduce((s, i) => s + (i.hours ?? 0), 0);
  $('#view').innerHTML = rows().map(r => {
    if (r.kind === 'day') return `<div class="row day" data-dropday="${r.day}">▾ ${r.day === 'not counted' ? 'NOT COUNTED' : `${dayName(r.day).toUpperCase()} ${r.day}`}<span class="num">${r.day === 'not counted' ? '' : loadByDay(r.day).toFixed(1) + 'h'}</span></div>`;
    if (r.kind === 'parent') return `<div class="row parent">├─ <span class="proj">${esc(r.project || 'unassigned')}</span> <span class="ptitle" data-parent="${esc(r.parent?.key ?? '')}">${esc(r.parent?.title ?? '')}</span>${r.parent?.linear?.created ? ` <a href="${esc(r.parent.linear.url)}" target="_blank">${esc(r.parent.linear.identifier)}</a>` : ''}</div>`;
    const i = r.item;
    const pushed = !!i.linear?.created;
    const editing = state.editing === i.id;
    const cls = ['row', 'item', i.id === fid ? 'focus' : '', pushed ? 'pushed' : '', state.mergeFrom === i.id ? 'marked' : ''].join(' ');
    return `<div class="${cls}" data-id="${i.id}" draggable="${!pushed}">
      <div class="line">│  ${i.id === fid ? '<span class="cursor">█</span>' : ' '} ${editing ? `<input class="edit-title" value="${esc(i.title)}">` : `<span class="title">${esc(i.title)}</span>`}
        <span class="proj">[${esc(i.project ?? '—')}]</span>
        <span class="num">${i.hours == null ? '  —' : i.hours.toFixed(1)}h</span>${i.locked ? '<span class="lock" title="locked">L</span>' : ''}
        ${pushed ? `<a href="${esc(i.linear.url)}" target="_blank">${esc(i.linear.identifier)}</a>` : ''}</div>
      ${editing ? `<textarea class="edit-desc" rows="3">${esc(i.description)}</textarea>` : `<div class="desc dim">${esc(i.description)}</div>`}
      <div class="why dim">${esc(i.bucketReason)}${i.weightReason ? ` · weight ${i.weight}: ${esc(i.weightReason)}` : ''}${i.evidence.manual ? ' · added by hand' : ` · ${i.evidence.commits.length} commits, ${i.evidence.sessions.length} sessions`}</div>
    </div>`;
  }).join('') + `<div class="row add">+ add item <span class="dim">(a)</span></div>`;
  if (state.editing) $('.edit-title')?.focus();
}

async function renderSettings() {
  const s = await api('GET', '/api/settings');
  $('#view').innerHTML = `
    <h3>projects</h3>${s.projects.map(p => `<div class="row">${esc(p.name)} <select data-kind="${esc(p.name)}"><option ${p.kind === 'billable' ? 'selected' : ''}>billable</option><option ${p.kind === 'internal' ? 'selected' : ''}>internal</option></select></div>`).join('')}
    <h3>repos</h3>${s.repos.map(r => `<div class="row"><span class="dim">${esc(r.name ?? r.root)}</span> <select data-repo="${esc(r.root)}">${['work', 'personal', 'ignore'].map(c => `<option ${r.class === c ? 'selected' : ''}>${c}</option>`).join('')}</select> <select data-repoproj="${esc(r.root)}"><option value="">—</option>${s.projects.filter(p => p.kind === 'billable').map(p => `<option ${r.project === p.name ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>`).join('')}
    <h3>work orgs</h3><input id="orgs" value="${esc(s.workOrgs.join(', '))}">
    <h3>sunday reminder</h3><label><input type="checkbox" id="nudge" ${s.nudge ? 'checked' : ''}> remind me</label>
    <div><button id="savesettings" class="accent">save settings</button> <span class="dim">keys: run <code>timesheet init</code> to reconnect</span></div>`;
  $('#savesettings').onclick = async () => {
    await api('PUT', '/api/settings', {
      projects: [...document.querySelectorAll('[data-kind]')].map(el => ({ name: el.dataset.kind, kind: el.value })),
      repos: [...document.querySelectorAll('[data-repo]')].map(el => ({ root: el.dataset.repo, class: el.value, project: document.querySelector(`[data-repoproj="${CSS.escape(el.dataset.repo)}"]`).value || undefined })),
      workOrgs: $('#orgs').value.split(',').map(s => s.trim()).filter(Boolean),
      nudge: $('#nudge').checked,
    });
    flash('settings saved');
  };
}

async function renderHistory() {
  const h = await api('GET', '/api/history');
  $('#view').innerHTML = h.map(w => `<div class="row hist" data-week="${w.week}">${w.week}<span class="num">${w.total.toFixed(1)}h</span> <span class="dim">${w.items} items · ${w.pushed ? 'pushed' : 'not pushed'}</span></div>`).join('') || '<div class="dim">no weeks yet</div>';
}

function renderStatus() {
  if (!state.draft) return;
  const t = live().reduce((s, i) => s + (i.hours ?? 0), 0);
  const by = {};
  for (const i of live()) by[i.project ?? 'unassigned'] = (by[i.project ?? 'unassigned'] ?? 0) + (i.hours ?? 0);
  const blocks = state.warnings.filter(w => w.level === 'block').length;
  const saved = state.saving ? '… saving' : (pendingPatches().items.length ? '● unsaved' : '✓ saved');
  $('#status').innerHTML = [state.week.replace(/^\d{4}-/, ''), `${t.toFixed(1)}h`, ...Object.entries(by).map(([p, h]) => `${esc(p.toLowerCase())} ${h.toFixed(1)}`), `${live().length} items`, state.draft.weightsSource ? `weights: ${state.draft.weightsSource}` : null, blocks ? `<span class="bad">${blocks} blocking</span>` : null, saved, state.flash ? `<span class="accent-text">${esc(state.flash)}</span>` : null].filter(Boolean).join(' · ') + `<span class="right">push ▸ P · help ?</span>`;
}

function renderPush() {
  const p = state.push;
  const el = $('#pushpanel');
  if (!p || p.status === 'idle') { el.hidden = true; return; }
  el.hidden = false;
  const lines = {
    running: `<span class="spin">⠋</span> ${esc(p.phase ?? '')} ${p.done ?? 0}/${p.total ?? 0}`,
    awaiting_sync: `! ${p.missing.length} issues not in Everhour yet. Open Everhour → Projects → ${esc([...new Set(p.missing.map(m => m.project))].join(', '))} → Sync, then <button id="continue" class="accent">continue</button>`,
    done: `✓ pushed · ${esc(state.week)}`,
    blocked: `✗ blocked: ${esc(p.warnings.map(w => w.message).join('; '))}`,
    error: `✗ ${esc(p.error)} <button id="continue">retry</button>`,
  };
  el.innerHTML = lines[p.status] ?? '';
  $('#continue')?.addEventListener('click', startPush);
}

function render() {
  renderHeader();
  if (state.tab === 'week') renderWeek();
  else if (state.tab === 'settings') renderSettings();
  else renderHistory();
  renderStatus();
  renderPush();
}

async function startPush() {
  await save();
  try { await api('POST', '/api/push', { week: state.week }); } catch (e) { return flash(e.message); }
  const poll = async () => {
    state.push = await api('GET', `/api/push?week=${state.week}`);
    renderPush();
    if (state.push.status === 'running') setTimeout(poll, 400);
    else await load(state.week);
  };
  poll();
}

function edit(id) { state.editing = id; renderWeek(); }
function commitEdit() {
  const it = state.draft.items.find(i => i.id === state.editing);
  if (it) { it.title = $('.edit-title').value.trim() || it.title; it.description = $('.edit-desc').value.trim() || it.description; }
  state.editing = null; renderWeek(); scheduleSave();
}

function addItem() {
  const day = focused()?.day ?? state.draft.days[0];
  const row = document.createElement('div');
  row.className = 'row additem';
  row.innerHTML = `<input id="newtitle" placeholder="title (2–3 words)"> <input id="newdesc" placeholder="description"> <select id="newproj">${state.projects.map(p => `<option>${esc(p.name)}</option>`).join('')}</select> <select id="newday">${state.draft.days.map(d => `<option ${d === day ? 'selected' : ''}>${d}</option>`).join('')}</select> <button id="newok" class="accent">add</button>`;
  $('#view').appendChild(row);
  $('#newtitle').focus();
  $('#newok').onclick = () => act('/api/items', { title: $('#newtitle').value, description: $('#newdesc').value, project: $('#newproj').value, day: $('#newday').value });
}

const HELP = [['j / k', 'move'], ['e', 'edit title + description (Enter save, Esc cancel)'], ['p', 'cycle project'], ['[ / ]', 'hours −/+ 0.5 (locks item)'], ['L', 'lock / unlock hours'], ['d d', 'delete'], ['m', 'mark, then m on another item to merge'], ['s', 'split into 2'], ['a', 'add item'], ['D', 'distribute'], ['P', 'push'], ['/', 'command palette'], ['?', 'this help']];

document.addEventListener('keydown', e => {
  if (state.editing) {
    if (e.key === 'Escape') { state.editing = null; renderWeek(); }
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); commitEdit(); }
    if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); commitEdit(); }
    return;
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
    if (e.key === 'Escape') { e.target.blur(); $('#palette').hidden = true; }
    return;
  }
  const it = focused();
  const n = itemRows().length;
  const k = e.key;
  if (k === 'j') state.focus = Math.min(n - 1, state.focus + 1);
  else if (k === 'k') state.focus = Math.max(0, state.focus - 1);
  else if (k === 'e' && it && !it.linear) { e.preventDefault(); return edit(it.id); }
  else if (k === 'p' && it && !it.linear) { const names = state.projects.map(p => p.name); it.project = names[(names.indexOf(it.project) + 1) % names.length]; scheduleSave(); }
  else if ((k === '[' || k === ']') && it && !it.linear) return act('/api/hours', { id: it.id, hours: Math.max(0.5, (it.hours ?? 0.5) + (k === ']' ? 0.5 : -0.5)) });
  else if (k === 'L' && it && !it.linear) { it.locked = !it.locked; scheduleSave(); }
  else if (k === 'd' && it && !it.linear) { if (state.armedDelete === it.id) { state.armedDelete = null; return act('/api/delete', { id: it.id }); } state.armedDelete = it.id; flash('press d again to delete'); }
  else if (k === 'm' && it && !it.linear) { if (state.mergeFrom && state.mergeFrom !== it.id) { const ids = [state.mergeFrom, it.id]; state.mergeFrom = null; return act('/api/merge', { ids }); } state.mergeFrom = it.id; flash('marked, press m on another item to merge'); }
  else if (k === 's' && it && !it.linear) return act('/api/split', { id: it.id, parts: 2 });
  else if (k === 'a') { e.preventDefault(); return addItem(); }
  else if (k === 'D') return act('/api/distribute', { reweight: false });
  else if (k === 'P') return startPush();
  else if (k === '/') { e.preventDefault(); $('#palette').hidden = false; $('#paletteinput').value = ''; return $('#paletteinput').focus(); }
  else if (k === '?') { const h = $('#help'); h.hidden = !h.hidden; h.innerHTML = HELP.map(([a, b]) => `<div><span class="key">${a}</span> ${b}</div>`).join(''); return; }
  else return;
  renderWeek(); renderStatus();
});

$('#paletteinput').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const [cmd, arg] = e.target.value.trim().split(/\s+/);
  $('#palette').hidden = true;
  if (cmd === 'distribute') act('/api/distribute', { reweight: false });
  else if (cmd === 'reweight') act('/api/distribute', { reweight: true });
  else if (cmd === 'push') startPush();
  else if (cmd === 'week' && arg) load(arg);
  else if (cmd === 'settings' || cmd === 'history' || cmd === 'week') { state.tab = cmd === 'week' ? 'week' : cmd; render(); }
});

document.addEventListener('click', e => {
  const t = e.target.closest('button, .row.item, .row.add, .row.hist');
  if (!t) return;
  if (t.dataset.tab) { state.tab = t.dataset.tab; return render(); }
  if (t.dataset.day) { const d = state.draft.days; state.draft.days = d.includes(t.dataset.day) ? d.filter(x => x !== t.dataset.day) : [...d, t.dataset.day].sort(); renderWeek(); renderHeader(); return scheduleSave(); }
  if (t.id === 'distribute') return act('/api/distribute', { reweight: false });
  if (t.id === 'reweight') return act('/api/distribute', { reweight: true });
  if (t.id === 'prev' || t.id === 'next') { const i = state.weeks.indexOf(state.week); const [y, w] = state.week.split('-W').map(Number); const d = new Date(Date.UTC(y, 0, 4 + (w - 1) * 7 + (t.id === 'next' ? 7 : -7))); return load(isoWeek(d)); }
  if (t.classList.contains('item')) { state.focus = itemRows().findIndex(r => r.item.id === t.dataset.id); renderWeek(); renderStatus(); }
  if (t.classList.contains('add')) addItem();
  if (t.classList.contains('hist')) { state.tab = 'week'; load(t.dataset.week); }
});

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - dow + 3);
  const y = t.getUTCFullYear(); const j4 = new Date(Date.UTC(y, 0, 4));
  return `${y}-W${String(1 + Math.round(((t - j4) / 86400000 - 3 + ((j4.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
}

$('#total').addEventListener('change', e => {
  const v = e.target.value.trim() === '' ? null : Number(e.target.value);
  if (v !== null && !(v > 0)) return flash('total must be a positive number');
  state.draft.totalHours = v; scheduleSave();
});

document.addEventListener('dragstart', e => { const r = e.target.closest('.row.item'); if (r) e.dataTransfer.setData('text/plain', r.dataset.id); });
document.addEventListener('dragover', e => { if (e.target.closest('[data-dropday]')) e.preventDefault(); });
document.addEventListener('drop', e => {
  const target = e.target.closest('[data-dropday]');
  if (!target || target.dataset.dropday === 'not counted') return;
  e.preventDefault();
  const it = state.draft.items.find(i => i.id === e.dataTransfer.getData('text/plain'));
  if (it && !it.linear) { it.day = target.dataset.dropday; renderWeek(); scheduleSave(); }
});

setInterval(async () => {
  if (!state.draft || state.saving) return;
  try {
    const { rev } = await api('GET', `/api/rev?week=${state.week}`);
    if (rev > state.base.rev && !pendingPatches().items.length && !state.editing) await load(state.week);
  } catch { /* server stopped */ }
}, 2000);

load(state.week).catch(e => { $('#view').innerHTML = `<div class="bad">✗ ${esc(e.message)}</div>`; });
```

- [ ] **Step 4: Write `src/server/public/styles.css` (the baseline tokens; refine with the design skills)**

```css
:root {
  --bg: #0b0c0b; --fg: #e8e6df; --dim: #8a8a83; --line: #2a2b28; --accent: #7cff6b; --bad: #ff5f56; --focus: #161815;
  --font: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) { --bg: #f6f5f0; --fg: #141413; --dim: #6b6b66; --line: #d9d7cf; --accent: #1f7a12; --bad: #c4271c; --focus: #ecebe4; }
}
:root[data-theme="light"] { --bg: #f6f5f0; --fg: #141413; --dim: #6b6b66; --line: #d9d7cf; --accent: #1f7a12; --bad: #c4271c; --focus: #ecebe4; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.55 var(--font); font-variant-numeric: tabular-nums; }
button, input, select, textarea { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 0; padding: 2px 8px; }
button { cursor: pointer; } button:hover { border-color: var(--fg); }
.accent { border-color: var(--accent); color: var(--accent); }
.accent-text { color: var(--accent); }
.dim { color: var(--dim); } .bad { color: var(--bad); }
header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line); padding: 10px 16px; z-index: 2; }
#tabs button { border: 0; color: var(--dim); padding: 0 12px 0 0; } #tabs button.on { color: var(--fg); text-decoration: underline; text-underline-offset: 4px; }
#weekbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
#days .day { width: 26px; padding: 2px 0; color: var(--dim); } #days .day.on { color: var(--bg); background: var(--fg); }
#total { width: 64px; text-align: right; }
.warn { margin-top: 4px; } .warn.block { color: var(--bad); } .warn.warn { color: var(--dim); }
main { padding: 8px 16px 72px; max-width: 1100px; }
.row { padding: 2px 0; white-space: pre-wrap; }
.row.day { margin-top: 14px; color: var(--fg); font-weight: 600; display: flex; justify-content: space-between; border-bottom: 1px solid var(--line); }
.row.parent { color: var(--dim); }
.row.item { padding: 4px 0 6px; border-left: 2px solid transparent; }
.row.item.focus { background: var(--focus); border-left-color: var(--accent); }
.row.item.marked { border-left-color: var(--fg); }
.row.item.pushed { opacity: .55; }
.row.item .line { display: flex; gap: 10px; align-items: baseline; }
.row.item .title { flex: 1; } .row.item .proj { color: var(--dim); }
.row.item .num { min-width: 52px; text-align: right; }
.row.item .desc, .row.item .why { padding-left: 4ch; }
.lock { color: var(--accent); }
.cursor { color: var(--accent); animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.edit-title { flex: 1; } .edit-desc { width: calc(100% - 4ch); margin-left: 4ch; }
.row.add { color: var(--dim); margin-top: 16px; cursor: pointer; }
#pushpanel { position: fixed; bottom: 28px; left: 0; right: 0; padding: 8px 16px; border-top: 1px solid var(--line); background: var(--bg); }
#status { position: fixed; bottom: 0; left: 0; right: 0; padding: 4px 16px; background: var(--fg); color: var(--bg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#status .right { float: right; } #status .bad { color: var(--bad); }
#palette { position: fixed; top: 20%; left: 50%; transform: translateX(-50%); width: min(560px, 92vw); border: 1px solid var(--fg); background: var(--bg); padding: 8px; }
#palette input { width: 100%; border: 0; }
#help { position: fixed; right: 16px; bottom: 40px; border: 1px solid var(--line); background: var(--bg); padding: 10px 14px; }
#help .key { display: inline-block; min-width: 6ch; color: var(--accent); }
h3 { font-size: 13px; margin: 18px 0 6px; color: var(--dim); text-transform: lowercase; }
a { color: var(--accent); }
@media (max-width: 640px) { .row.item .line { flex-wrap: wrap; } #status .right { display: none; } }
@media (prefers-reduced-motion: reduce) { .cursor { animation: none; } }
```

- [ ] **Step 5: Remove the placeholder and build**

```bash
rm src/server/public/.keep
npm run build && npm test
```
Expected: the build succeeds and all tests pass.

- [ ] **Step 6: Check it by hand in the browser**

Seed a demo week, then open the UI:

```bash
export TIMESHEET_HOME="$(mktemp -d)" TIMESHEET_SECRETS_FILE="$TIMESHEET_HOME/s.json"
node -e '
const fs=require("fs"),p=process.env.TIMESHEET_HOME;
fs.writeFileSync(p+"/config.json",JSON.stringify({version:1,linear:{assigneeId:"u",assigneeEmail:"me@x"},everhour:{userId:1},projects:[{id:"a",name:"Boxsy",teamId:"t",kind:"billable",stateId:"s",labelIds:[]},{id:"b",name:"Dev - Internal",teamId:"t2",kind:"internal",stateId:"s2",labelIds:[]}],internalProject:"Dev - Internal",workOrgs:[],gitEmails:[],nudge:false,port:4747}));
fs.mkdirSync(p+"/weeks/2026-W41",{recursive:true});
const items=["Deck reader","Website reader","Field mapper","Extract endpoint","Confirm screen","Gemini catalog scan"].map((t,i)=>({id:"i"+i,title:t,description:"Did the technical work for "+t+".",project:i===5?"Dev - Internal":"Boxsy",bucketReason:i===5?"research the client did not ask for":"client feature",day:"2026-10-0"+(5+i%3),evidence:{commits:[],sessions:[],manual:false},weight:null,weightReason:null,hours:null,locked:false,edited:false,deleted:false,linear:null,everhour:null}));
fs.writeFileSync(p+"/weeks/2026-W41/draft.json",JSON.stringify({week:"2026-W41",rev:1,totalHours:null,days:["2026-10-05","2026-10-06","2026-10-07","2026-10-08","2026-10-09"],weightsSource:null,pushed:false,items,parents:[]}));'
node dist/cli/index.js review --week 2026-W41
```

Then check each of these in the browser:
- Type `30` in total and press `D`. The hours appear, they sum to 30.0 in the status bar, and the days are balanced.
- Use `j`/`k`, then `e` to edit and Enter to save. The status bar goes `● unsaved` then `✓ saved`.
- Press `p` to flip a project, then confirm `$TIMESHEET_HOME/examples.jsonl` has a `bucket` line.
- Press `]` on an item. It locks (L), and the total still reads 30.0.
- Press `d` twice to delete an item.
- Press `/`, type `settings` and press Enter.
- Toggle macOS dark/light mode. Both themes should be readable.

Stop the server with Ctrl+C.

- [ ] **Step 7: Commit**

```bash
git add src/server/public
git rm --cached -q src/server/public/.keep 2>/dev/null || true
git commit -m "feat: keyboard-first terminal-style review UI"
```

---

### Task 17: README, spec touch-ups, and the real-account smoke test

**Files:**
- Create: `README.md`
- Modify: `docs/superpowers/specs/2026-10-06-my-timesheet-design.md` (§9 step 4: the endpoint is `POST /time`)

**Interfaces:**
- Consumes: the whole CLI.
- Produces: docs, plus a verified end-to-end run against the real Linear and Everhour accounts.

- [ ] **Step 1: Fix the spec's time endpoint**

In §9, step 4, replace `` `POST /tasks/li:{uuid}/time` with `{time: hours×3600, user, date: item.day}`. Before each post, read the task's time records and skip if the user already has time on that date. `` with:

`` `POST /time` with `{task: "li:{uuid}", user, date: item.day, time: hours×3600}`. Everhour upserts one record per (user, date, task), so repeating the call is safe and needs no read-before-write. ``

- [ ] **Step 2: Write `README.md`**

````markdown
# my-timesheet

Turn a week of Claude Code sessions and git commits into Linear issues with hours in Everhour, with a 10-minute review in between.

```
npx my-timesheet init      # once: keys, projects, work orgs, hooks
# …work all week…
/timesheet                 # in Claude, on Sunday: drafts the week
/timesheet review          # browser: edit, type your total, distribute, push
```

## How it works

- **During the week:** a Stop hook writes one line per Claude turn to `~/.timesheet/log/`, for **work repos only**:
  - a repo is work if a remote belongs to one of your work GitHub orgs;
  - any other repo is asked about once (Work / Personal / Ignore);
  - nothing is logged until you answer.
- **`/timesheet`:** condenses those sessions and your commits. Claude drafts sub-issues grouped by day and project, each with a billable/internal reason.
- **Review:** type the week's total. Claude weighs each item's effort, and code splits the total exactly:
  - in 0.5h steps;
  - no sub-issue over 3h (bigger ones are split);
  - days roughly even.
- **Push:** creates the parent issues and sub-issues in Linear. You click **Sync** once in Everhour (its API can't import new issues), and the hours are logged. Re-running is always safe.

## Commands

| | |
|---|---|
| `timesheet review [--week last]` | open the review UI |
| `timesheet push [--week last]` | push from the terminal |
| `timesheet status` | one-line summary |
| `timesheet repo work --project Boxsy` | classify the current repo |
| `timesheet doctor` | check keys, hooks and tools |
| `timesheet uninstall [--purge]` | remove hooks (and data) |

Keys live in the macOS Keychain. Everything else is in `~/.timesheet/`. Nothing is sent anywhere until you press push.
````

- [ ] **Step 3: Commit the docs**

```bash
git add README.md docs/superpowers/specs/2026-10-06-my-timesheet-design.md
git commit -m "docs: README and spec correction for the Everhour time endpoint"
```

- [ ] **Step 4: Real-account smoke test (do this with the user present)**

The user will need to type their API keys at the `init` prompts.

```bash
npm run build && npm link
timesheet init          # choose Boxsy + Dev - Internal, status Done
timesheet doctor        # every line ✓
```

Then build a throwaway week and push only **Dev - Internal** items:

```bash
W=2026-W41
mkdir -p ~/.timesheet/weeks/$W
cat > ~/.timesheet/weeks/$W/proposal.json <<'EOF'
{ "items": [
  { "title": "Timesheet smoke one", "description": "Smoke test item for my-timesheet. Safe to delete.", "project": "Dev - Internal", "bucketReason": "tooling test", "day": "2026-10-06", "evidence": { "commits": [], "sessions": ["smoke-1"] } },
  { "title": "Timesheet smoke two", "description": "Smoke test item for my-timesheet. Safe to delete.", "project": "Dev - Internal", "bucketReason": "tooling test", "day": "2026-10-06", "evidence": { "commits": [], "sessions": ["smoke-2"] } }
] }
EOF
timesheet ingest --week $W
timesheet review --week $W     # total 1, Distribute → 0.5h each, Push
```

Expected:
- One parent and two sub-issues appear in Linear (Dev - Internal, assigned to the user, Done).
- The UI shows the "click Sync in Everhour" step.
- After the user clicks Sync and presses continue, Everhour shows 0.5h on each sub-issue for 2026-10-06.
- Pressing push again changes nothing (the counts stay the same).

- [ ] **Step 5: Clean up the smoke test data**

Zero out the time. Everhour deletes a record when you upsert `time: 0`.

```bash
node -e '
const d=require(process.env.HOME+"/.timesheet/weeks/2026-W41/draft.json");
console.log(d.items.filter(i=>i.linear).map(i=>i.linear.uuid).join("\n"))' > /tmp/smoke-uuids
```

For each UUID, POST `{task:"li:<uuid>", user:<id>, date:"2026-10-06", time:0}` to `https://api.everhour.com/time`, using the key from `security find-generic-password -s my-timesheet.everhour -w`.

Then delete the 3 Linear issues: either the user does it in the UI, or `Linear.deleteIssue` is called from a short node one-off using the Keychain key. Finally:

```bash
rm -rf ~/.timesheet/weeks/2026-W41
```

Confirm in Everhour that the week's total is back to its earlier value.

- [ ] **Step 6: Record what was verified**

Append to the spec's "Verified facts" section:
- `POST /time` upserts (the second push didn't double the hours);
- `time: 0` removes a record;
- `issueCreate` accepts a client `id`.

Note anything that behaved differently. Then commit:

```bash
git add docs/superpowers/specs/2026-10-06-my-timesheet-design.md
git commit -m "docs: record smoke-test results against real Linear and Everhour"
```
