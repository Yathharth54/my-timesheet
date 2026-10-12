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
  - The review server only listens on 127.0.0.1 and rejects cross-site requests.
- **Push:** creates the parent issues and sub-issues in Linear. You click **Sync** once in Everhour (its API can't import new issues), and the hours are logged. Re-running is always safe. While a push runs, the week can't be edited.

## In Claude: `/timesheet`

| | |
|---|---|
| `/timesheet` | draft this week from your sessions and commits |
| `/timesheet last` | draft last week |
| `/timesheet 2026-W41` | draft a given week |
| `/timesheet review` | open the review page for this week (`review last` or `review 2026-W41` for others) |
| `/timesheet repo work --project Boxsy` | mark the current repo as work, billed to a project (`repo personal`, `repo ignore`) |
| `/timesheet move Tuesday's issues to Dev - Internal` | any change in plain words. Claude edits the week through `timesheet edit`, and asks before deleting anything already in Linear |

Recurring work (a standup, a team sync, a client call) is one Linear issue logged on several days. Ask for it in plain words ("log the team sync on Tuesday and Thursday too"), or use Copy in the review page.

## In the review page

Press `/` or ⌘K for Ask Claude and the command list: Itemise hours, Estimate effort again, Print, Add an issue, Copy the issue to other days, Pick every issue, Past weeks, Settings, Keyboard shortcuts, and `week last`, `week next` or `week 2026-W40` to jump. Anything else you type goes to Claude, which previews its changes on the receipt before you apply them.

| Key | |
|---|---|
| `j` / `k` | next / previous issue |
| `e` | edit the title |
| `p` | next project |
| `[` / `]` | half an hour less / more (locks the hours) |
| `L` | lock or unlock hours |
| `c` | copy the issue to other days (stays one Linear issue) |
| `s` | split in two |
| `m` | mark, then `m` on another issue to merge |
| `d d` | delete the issue |
| `x` | pick the issue for bulk changes (shift-click picks a range) |
| `a` | add an issue (several days and hours at once) |
| `D` | itemise hours |
| `P` | print to Linear and Everhour |
| `/` or ⌘K | Ask Claude and commands |
| `?` | show the shortcuts |
| `Esc` | close, or clear picked issues |

Picked issues get a bar at the bottom: move to a project or day, copy to more days, merge, delete.

## In the terminal

| | |
|---|---|
| `npx my-timesheet init` | first setup: keys, projects, work orgs, hooks |
| `timesheet review [--week last]` | open the review page |
| `timesheet push [--week last]` | push from the terminal |
| `timesheet status` | one-line summary |
| `timesheet show [--week last]` | the week as JSON, with issue ids |
| `timesheet edit --ops changes.json [--remote]` | apply changes (move, rename, merge, delete, copy to more days); `--remote` also deletes pushed issues from Linear and Everhour |
| `timesheet repo work --project Boxsy` | classify the current repo |
| `timesheet doctor` | check keys, hooks and tools |
| `timesheet uninstall [--purge]` | remove hooks (and data) |

Keys live in the macOS Keychain. Everything else is in `~/.timesheet/`. Nothing is written to Linear or Everhour until you push, or until you confirm deleting a pushed issue (it goes to Linear's trash and its Everhour time is cleared). Before that, Distribute sends item titles, descriptions and evidence counts to Claude via `claude -p`, Ask Claude in the review page (press `/` or ⌘K) sends the week's issues to Claude the same way; its suggestions only apply when you press Apply. The review page also reads your week's Everhour total.
