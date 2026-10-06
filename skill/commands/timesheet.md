---
description: Draft, review or configure this week's timesheet (my-timesheet)
argument-hint: "[last | YYYY-Www | review | repo <work|personal|ignore> [--project NAME]]"
---

Arguments: $ARGUMENTS

- If the arguments start with `review`: run `timesheet review` as a background process (it starts a local server and opens the browser). Tell the user the URL it prints, in one line.
- If the arguments start with `repo`: run `timesheet $ARGUMENTS` in the current directory and report the result in one line.
- Otherwise: use the `timesheet` skill to draft the week. The week is `last` if the arguments contain `last`, a `YYYY-Www` value if one is given, and `this` otherwise.
