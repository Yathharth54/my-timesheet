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
4. Run `timesheet ingest --week <same week>`. Relay its one-line summary. Then tell the user to run `/timesheet review <the same week>` (e.g. `/timesheet review last`, or `/timesheet review 2026-W40`; plain `/timesheet review` for this week) to edit the items, set the total and push.

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
