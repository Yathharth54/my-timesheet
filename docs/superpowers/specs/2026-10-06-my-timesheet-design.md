# my-timesheet — design spec

Date: 2026-10-06
Status: approved in brainstorming, pending written-spec review

## 1. Purpose

Turn a week of Claude Code sessions and git commits into Linear issues with hours logged in Everhour, with one short review step in between. It replaces the current manual flow: export chats, prompt for issue markdown, build a day-wise worksheet, create issues through the Linear MCP, sync Everhour by hand, then curl the hours. That flow takes 1–2 hours every Sunday.

**Users:** the author first. It is designed so teammates can install it with their own config, and nothing org-specific is hardcoded.

**Success criteria**
- A normal week goes from `/timesheet` to pushed in 10–15 minutes of review.
- Nothing from personal repos is ever captured.
- The hours logged equal the total the user typed, exactly.
- A push can be re-run or resumed without creating duplicates in Linear or Everhour.

## 2. Names and surfaces

| Surface | Name |
|---|---|
| npm package | `my-timesheet` (checked as free on 2026-10-06) |
| First install | `npx my-timesheet init` (also installs globally) |
| CLI binary | `timesheet` (`init`, `review`, `push`, `status`, `repo`, `doctor`, `uninstall`) |
| Claude command | `/timesheet`, `/timesheet last`, `/timesheet review`, `/timesheet repo <work\|personal\|ignore>` |
| Data dir | `~/.timesheet/` |

## 3. Key decisions (from brainstorming)

1. **Capture uses hooks plus an index.** Hooks never call a model and never copy transcripts. All summarising happens when `/timesheet` runs.
2. **Work vs personal.** A repo is work automatically if any of its remotes is owned by a configured work GitHub org. Anything else is asked about once (Work / Personal / Ignore) and the answer is remembered. **Unclassified means nothing is logged.**
3. **Billable vs internal** is decided per item by Claude, with a one-line reason. The test: did the client ask for it, or will they see the output? Then billable; otherwise internal. The user flips items in the UI, and flips are saved as examples for future drafts.
4. **Hours are not measured.** The user types one weekly total. Claude assigns relative weights per item, and plain code converts the weights to hours.
5. **Days are split roughly evenly**, so items may move to a nearby day for balance.
6. **No sub-issue is over 3h.** Items whose share is larger get split into separate sub-issues; hours are never cut.
7. **Everhour sync needs one manual click.** The sync API was tested and does not import new issues into a project that is already synced (see §9). The tool waits, then confirms every task arrived.
8. **Linear and Everhour are called directly over their APIs**, not through the MCP, so retries and resuming are predictable.
9. **Meetings and other untracked work** are added by hand in the UI.
10. **Everhour's timesheet "Submit" is never touched.** "Pushed" is local state only.

## 4. Architecture

```
 Claude Code sessions ──hooks──▶ ~/.timesheet/log/<week>.jsonl   (index only)
                                          │
 /timesheet (skill) ── condense.ts ──▶ digests + git log ──▶ Claude drafts
                                          │
                                          ▼
                         ~/.timesheet/weeks/<week>/draft.json   (source of truth)
                                          │
              timesheet review ──▶ localhost server + UI (edit, Distribute)
                                          │
              Push ──▶ linear.ts (GraphQL) ──▶ everhour.ts (sync, poll, time)
```

### Package layout
```
bin/       timesheet CLI entry
hooks/     session-start.js, stop.js         (no dependencies, target <50ms)
skill/     SKILL.md, commands/timesheet.md   (drafting rules and procedure)
server/    local HTTP server + single HTML/JS page (no build step)
lib/
  repo.ts        repo root, remote parsing, classification
  condense.ts    transcript → digest
  merge.ts       draft re-run merge (edits, tombstones)
  distribute.ts  weights → hours (pure, deterministic)
  linear.ts      GraphQL client
  everhour.ts    REST client
  keychain.ts    secret storage
```
Each lib module is pure or has one external dependency, and is tested on its own.

## 5. Capture (hooks)

**SessionStart**
1. `git rev-parse --show-toplevel` finds the repo root. If the folder isn't a git repo, the folder path is used.
2. Look up the root in `~/.timesheet/repos.json`. A saved answer is used as-is.
3. Otherwise parse `git remote -v` for every remote (https and ssh forms) and take the owner. If an owner is in `config.workOrgs`, save the repo as `work`.
4. Otherwise emit `additionalContext` telling Claude to ask once: "Work / Personal / Ignore?". For Work, it also asks which billable project the repo maps to. Claude saves the answer through `timesheet repo …`.
5. For personal or ignored repos, nothing is written.

**Stop** (each turn; work repos only). Appends one line:
```json
{"t":"ISO-8601","session":"<id>","repo":"<owner/name or path>","project":"<default project>","transcript":"<path>"}
```
to `~/.timesheet/log/<ISO-week>.jsonl`. The Stop hook is used instead of SessionEnd because sessions often never end cleanly.

**Transcript retention:** Claude Code deletes transcripts after 30 days by default. `/timesheet` warns when indexed transcripts are missing and falls back to commits only.

## 6. Drafting (`/timesheet`)

1. Resolve the week. Default is the current ISO week (Mon–Sun); `last` means the previous week.
2. `condense.ts` turns each indexed session into a digest: user prompts, files edited, commands run, and Claude's final replies (trimmed), with no tool output dumps. Digests are temporary and deleted after drafting.
3. Collect commits for the week from the mapped work repos with `git log --author=<git email>`.
4. Claude, following `SKILL.md`, writes or merges `draft.json`.

**Writing rules**
- Sub-issue titles are 2–3 words; descriptions are 2–4 technical sentences.
- No hours in any title or description.
- One sub-issue covers one piece of work.
- Every item carries `project` and `bucketReason`.
- Parent: title `<Weekday> — <theme>`; description `## YYYY-MM-DD` + a 2–3 sentence summary + `{N} sub-tasks.`. One parent per day per project, regenerated from its children.
- Past bucket flips and rewrites from `~/.timesheet/examples.jsonl` are included as few-shot examples.

**Merge on re-run**
- Items are keyed by their evidence (commit SHAs, session IDs).
- New uncovered evidence becomes new items.
- `edited: true` items are never rewritten.
- Deleted items become tombstones and are not recreated.
- Items already pushed are never changed.

### draft.json
```
{
  week: "2026-W40", totalHours: number|null, days: ["2026-09-28", ...],
  weightsSource: "claude"|"heuristic"|null,
  items: [{
    id, title, description, project, bucketReason, day,
    evidence: { commits: [], sessions: [], manual: bool },
    weight, weightReason, hours, locked, edited, deleted,
    linear: { uuid, identifier } | null,
    everhour: { logged: bool } | null
  }],
  parents: [{ key: "<day>|<project>", title, description, linear: {...}|null }]
}
```

## 7. Review UI (`timesheet review` → `http://127.0.0.1:4747`)

The server listens on loopback only, and keys never reach the browser. Edits autosave. The page reloads `draft.json` on external change and keeps unsaved edits.

**Week tab**
- Header: week picker, day toggles, total hours, Distribute and Re-weight buttons, and "Already in Everhour: Xh".
- Body: days → project parents → sub-issues.
- Item actions: inline edit, project dropdown, hours ±0.5 with rebalance, lock, drag to another day, merge, split, delete, and "+ Add item".
- Blocking warnings: an item with no project, an item over 3h, or a total mismatch.

**Settings tab:** repo mapping, work orgs, Linear status and labels, reconnecting keys.

**History tab:** past weeks, totals, links to the Linear issues.

### Visual direction
Build with the `frontend-design`, `ui-ux-pro-max:design` and `ui-ux-pro-max:brand` skills during implementation.

- **Overall:** a minimal, classy terminal aesthetic.
- **Type:** monospace only (JetBrains Mono or IBM Plex Mono), with tabular numbers.
- **Colour:** near-black background, off-white text, grey for secondary text, one accent (phosphor green or amber) for actions and state, and red only for blocking warnings. No gradients, shadows or rounded cards.
- **Structure:** box-drawing dividers, and a tmux-style status bar: `W41 · 68.0h · boxsy 49.0 · internal 19.0 · 34 items · ✓ saved`.
- **Keyboard first:** `j/k`, `e`, `p`, `[`/`]`, `L`, `d`, `a`, `/` palette, `?` help. The mouse works too.
- **Motion:** minimal (block cursor on the focused row, hours updating in place).
- **Light mode:** the same layout with inverted colours.

### CLI style
In the style of uv: short and quiet.
- One line per step, ending in a dim timing, with braille spinners and progress counters.
- `+` lines for things added.
- Colour only for ✓/✗, no emoji, and one summary line at the end.
- Libraries: `@clack/prompts` for interactive prompts, `picocolors` for colour.

## 8. Distribute

1. **Weights.** The server runs `claude -p` (on the user's Claude Code login) with each unlocked item's title, description and condensed evidence (diff size, files touched, prompt and session counts, span). It returns `{id, weight 1–10, reason}`. Manual items with no evidence are weighted from their text.
2. **Hours** (`distribute.ts`, pure code):
   - `remaining = total − Σ locked`, shared out by weight.
   - Any item over 3h: Claude splits it into 2–3 sub-items with their own titles, and the hours are divided between them.
   - Bin-pack items into the counted days so each day is within ±1h of the average, keeping items on their own day where possible.
   - Round to 0.5h with largest-remainder rounding, so the sum is exactly `total` and every item is at least 0.5h.
3. Pressing Distribute again reuses the cached weights and is instant; Re-weight calls Claude again.
4. **Fallback:** if `claude -p` fails, weights come from the evidence alone (diff lines and session minutes), and the status bar shows `weights: heuristic`.

## 9. Push

**Preflight:** no blocking warnings, the sum equals the total, and the user confirms if Everhour already has more than 0h for them that week.

1. **Linear parents.** `issueCreate` with team, project, assignee, configured state and optional labels, and no `parentId`. The UUID is saved to `draft.json` straight away.
2. **Linear sub-issues.** The same, with `parentId`, at most 5 at a time, retrying with backoff on 429, 5xx or network errors.
3. **Everhour sync (manual click; see Verified facts).** The UI and CLI ask the user to click Sync in Everhour for the projects touched, then press Continue. The tool then polls `GET /tasks/li:{uuid}` until every sub-issue exists. Nothing is logged until all tasks exist. `POST /projects/li:{linearProjectId}/sync` is still called first in case Everhour fixes this, but the flow doesn't rely on it.
4. **Log time** on sub-issues only: `POST /tasks/li:{uuid}/time` with `{time: hours×3600, user, date: item.day}`. Before each post, read the task's time records and skip if the user already has time on that date. Throttled to stay under Everhour's rate limit.

**Resuming:** every step saves its result per item as it goes, so re-running the push resumes where it stopped.

**After the push:** items are read-only and link to Linear. New items go out as an extra batch on the next push. The week is marked `pushed`, which is local state only.

**Verified facts (2026-10-06, real keys, test issue THE-2224):**
- Everhour task ID = `li:{Linear issue UUID}` (not the `THE-123` identifier). The task's `projects` field is `["li:{Linear project UUID}"]`.
- Everhour project ID = `li:{Linear project UUID}`. Everhour's project list also contains **Linear teams** with the same `li:{uuid}` format, and some share a name with a project (e.g. the Boxsy team `li:6b82…` vs the Boxsy project `li:1c61…`). Always match on the Linear project UUID, never on the name.
- `POST /projects/{id}/sync` on an already-synced project returns 200 with the project but does **not** import new issues. Polled for about 4.5 minutes with the issue in both Backlog and Done, it stayed 404. A manual Sync click in the Everhour UI made the task appear straight away.

## 10. Config and secrets

- `~/.timesheet/config.json` holds Linear team, projects (billable or internal), assignee, state, labels, Everhour user ID, work orgs, gap and day settings, and whether the Sunday nudge is on. It contains no secrets.
- `~/.timesheet/repos.json`: repo root → `{class, project}`.
- **Secrets:** the macOS Keychain via `security`. On other platforms, a `0600` file. Secrets never appear in prompts, logs or `draft.json`.

**`init` steps**
1. Linear key, then a live project picker with billable/internal tags.
2. Everhour key, then the user ID and a check that the Linear integration is active.
3. Work orgs from `gh api user/orgs`.
4. Install the hooks and command into `~/.claude/`.
5. Optional Sunday nudge (default off).

`uninstall` removes only what was added; `--purge` also deletes `~/.timesheet/`.

## 11. Error handling

| Case | Behaviour |
|---|---|
| Hook fails | Fails silently (exit 0) and logs to `~/.timesheet/hook-errors.log`. It must never block a session. |
| Transcript missing | Warn, and draft from commits only for that session. |
| `claude -p` fails | Heuristic weights, shown in the status bar. |
| Linear or Everhour 429/5xx | Retry with backoff, then mark the item failed. The push can be resumed. |
| Everhour task not synced | Manual Sync, then Continue. |
| Draft changed while the UI is open | Reload and keep unsaved edits. |

## 12. Testing

**Unit tests**
- `distribute.ts`: exact sum, nothing over 3h, day balance, locks respected, the 0.5h floor.
- `repo.ts`: https/ssh/upstream remotes, no remote, worktrees.
- `merge.ts`: edits kept, tombstones respected, pushed items frozen.
- `condense.ts`: fixtures of real transcript shapes.

**Integration tests:** mocked Linear and Everhour HTTP. Kill the push at random steps, resume, and assert nothing was created twice or logged twice.

**Hooks:** a timing check (<50ms), and confirming that unknown or personal repos write nothing.

**Smoke test:** a throwaway Linear project plus the real Everhour account, run once before the first real week.

## 13. Out of scope (v1)

Google Calendar import, Everhour submit/approval, a hosted version, team dashboards, trackers other than Linear, and editing after the push.
