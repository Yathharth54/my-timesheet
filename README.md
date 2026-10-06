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
