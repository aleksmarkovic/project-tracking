# Client Workbench

A local tracker for client work: what you need to do, what you did, and how far along each project is.
Data lives in a local Postgres database. You use it through a web page or the `track` command.

## Setup

Needs Node 22+ and a running Postgres (Homebrew's `postgresql@18` works out of the box:
`brew install postgresql@18 && brew services start postgresql@18`).

The page, the server and the `track` command run anywhere Node and Postgres do. The
[auto-update](#auto-update) is macOS only: it's a launchd job, and it logs to `~/Library/Logs`.

```bash
npm install
npm run setup      # creates the project_tracking database and its tables
npm start          # http://localhost:4567
```

`npm run dev` does the same but restarts the server whenever a file changes. Either way the server prints its
errors in that terminal, and stops when you close it. Keep it running while you work: scheduled reviews and
daily statuses only run while the server is up. The auto-update and the `track` command don't need it.
To update, pull and restart the server. The schema is applied on every start, so there's no migration step.

Settings, all optional:

| Variable       | Default                                          |
| -------------- | ------------------------------------------------ |
| `DATABASE_URL` | `postgresql://localhost:5432/project_tracking`   |
| `PORT`         | `4567`                                           |
| `HOST`         | `127.0.0.1` (only reachable from this machine)   |
| `REPOS_DIR`    | `~/Desktop/repos` (to match PRs to projects)     |

The server only answers requests addressed to `localhost` or `127.0.0.1`, so a tunnel such as ngrok gets a 403.
It also refuses API requests that the browser marks as coming from another site (`Sec-Fetch-Site`), including
other apps on localhost. The page itself, the address bar, curl and scripts are unaffected.

### Claude features (optional)

The board, notes, the log, the `track` command and the pull request list need nothing more than the setup
above. The [auto-update](#auto-update), [Claude reviews](#claude-reviews) and [daily status](#daily-status) run
Claude Code headlessly (`claude -p`) and need:

- Claude Code, signed in, at `~/.local/bin/claude` (or set `CLAUDE_BIN`).
- For ticket sync: the Atlassian (Jira) and/or Linear connector on your claude.ai account, and a Jira site or
  Linear team on each project (see [Auto-update](#auto-update)).
- Two skills in `~/.claude/skills/`. They aren't part of this repo, so bring your own:

| Skill          | Used by                                                     | What it must provide |
| -------------- | ----------------------------------------------------------- | -------------------- |
| `code-review`  | Claude reviews                                              | Runs as `/code-review <PR url>`. Reviews the PR (the run may use `gh pr view`, `gh pr diff`, read-only `git` and the file tools) and ends on one of three verdicts: "Looks good", "A couple of things first" or "Wouldn't merge yet". The server asks for the result as structured output (`SCHEMA` in `lib/review.js`), so the skill only has to review. A "Posting to GitHub" section saying how findings are anchored to diff lines makes the line comments better. |
| `daily-status` | Daily status, and the auto-update's "log today's work" step | Runs as `/daily-status YYYY-MM-DD`. Must ship `scripts/gather_local.py`, which the runs call as `python3 ~/.claude/skills/daily-status/scripts/gather_local.py [repos_dir] [--date YYYY-MM-DD]` (defaults: `~/Desktop/repos`, today). It prints that day's git commits, GitHub PRs and Claude Code sessions under one `## <folder>` heading per top-level folder of the repos dir. The skill turns that into one short list per client: the client's name in bold, then `- ` bullets. It may also read Jira and Confluence through the Atlassian connector. |

Without `code-review`, the reviews have no skill to run. Without `daily-status`, the daily status can't be written,
and the auto-update still syncs tickets but names its log step as failed.

## First steps

1. **Add a project for each client** with **New project** on the page, or `track project add "Acme Co"`.
   Give it the same name as the client's folder in `~/Desktop/repos`. Names are compared in lowercase with
   anything that isn't a letter or digit turned into `-`, so "Acme Co" matches `acme-co`. See
   [how projects are matched](#how-projects-are-matched-to-your-repos) for why this matters.
2. **Add tasks** with **N** on the page, or `track add acme-co "Checkout page redesign"`. Work that isn't
   for a client goes to Common (`track add common "..."`).
3. *(Optional)* **Show your pull requests:** install the GitHub CLI and run `gh auth login`.
4. *(Optional)* **Sync tickets and log work automatically:** give each project its Jira site or Linear team in
   the project dialog (or `track project jira acme-co acme.atlassian.net` / `track project linear acme-co "Acme"`),
   then `npm run auto:install`. Try one run straight away with `npm run auto:run`. This and the Claude reviews
   and daily status need the [Claude features](#claude-features-optional) set up.

### How projects are matched to your repos

The tracker has no settings for repo paths. It finds a project's work by its name:

- **Pull requests** are matched by the clone's folder in `~/Desktop/repos` (or `REPOS_DIR`), then the GitHub
  org, then the repo name, ignoring dashes and case. A PR that matches nothing is still listed, without a project.
- **The auto-update's work log and the daily status** group the day's work by folder, and the auto-update logs
  each folder's work to the project with that name. A client folder with no matching project gets a new
  project, so a project named differently from its folder can end up with a duplicate.

If a name doesn't match, rename the project (in its dialog, or `track project rename <project> <new name>`)
rather than the folder.

## The page

- **Summary**: open, in progress, waiting, overdue, and done this week. Click a project to filter everything to it.
- **Projects**: one card per client. The ring shows how many of its tasks are done. A project with no
  activity for 30 days says how long it's been quiet and highlights **Archive**.
- **Common**: a built-in project, listed first, for tasks that aren't for a client (invoices, admin,
  learning). It can be renamed but not archived or deleted, and the auto-update leaves it alone.
- **Pull requests**: open GitHub PRs in four lanes by who acts next. **Review requested** lists
  PRs waiting for your review. Your own PRs are split into **Ready to merge** (approved), **Changes
  requested** (including PRs whose reviewers only left comments), and **Awaiting review** (including
  drafts, and PRs nobody was asked to review). Cards flag failing checks and merge conflicts.
  A card in **Ready to merge** has a **Merge** button that merges the PR on GitHub with the method GitHub's
  own button would use (merge, squash or rebase), after a second click that names the base branch. GitHub
  refuses it if anyone pushed since the page loaded. A PR GitHub won't merge yet (branch rules, behind its
  base, conflicts) shows why instead of the button. Each PR is matched to a project through the repo's clone in
  `~/Desktop/repos` (or its GitHub org name), so the project filter applies here too. PRs nobody
  has touched in 90 days are folded away behind a "Show older PRs" link. Data comes from the GitHub CLI
  (`gh`, signed in with `gh auth login`), refreshed every minute. Each PR waiting for your review gets
  a Claude review (see below).
- **Board**: To do, In progress, Waiting (on a client or a review), and Done (last 14 days). Drag cards
  between lanes, tick the circle to finish a task, click a title to edit it. Press `N` for a new task.
- **Notes**: at the top of the sidebar. Write anything (⌘↩ saves) and file it under a project, or
  under Common. Pin a note to keep it on top, click **Edit** to change it in place, and links in a
  note are clickable. Long notes fold after twelve lines. An unsaved note survives a reload. The
  project filter applies here too, and an archived project's notes come back when you restore it.
- **What I did**: a 14-day chart of finished tasks and logged actions, a box to log anything that isn't
  a task (a call, a review, research), and the history grouped by day. Each day starts with its daily
  status: what your `/daily-status` skill says you did that day, one short list per client (see
  [Daily status](#daily-status)). **Copy** on a list copies its bullets to send to that client. The
  tracker's own entries for the day fold away under it.
- **Archived projects**: at the bottom. Archiving hides a project from the board and the summary but keeps
  its tasks and history. Restore it from there. Adding a new task to an archived project restores it.
  **Delete** there removes the project with all its tasks, notes and history, after a second click. Only an
  archived project can be deleted, and Common can't be.

Deleting is always two clicks: the button asks once more before it acts. That goes for a task (**Delete** in
its dialog), a logged entry in **What I did** (the **×** next to it; entries the tracker wrote itself, like
"Started", can't be deleted), a note, and a project.

Keyboard: **N** opens a new task (when you're not typing). In a note, **⌘↩** (Ctrl+Enter) saves and **Esc**
stops editing. **Esc** closes any dialog.

The page refreshes every 15 seconds, so changes made from the terminal show up on their own. **Refresh** in
the top bar reloads everything at once and asks GitHub again instead of using its one-minute cache. It
doesn't start reviews or the auto-update.

## The `track` command

Works straight against the database, so the server doesn't need to be running.

```bash
npm run -s track -- <command>      # or: node bin/track.js <command>
npm link                           # optional: makes `track` available everywhere
```

```bash
track                                   # open tasks, grouped by project
track add acme-co "Checkout page redesign" --high --due 2026-10-20 --link https://...
track start 12        track wait 12        track done 12        track reopen 12
track edit 12 --due none --priority low --note "Waiting on API keys"
track add common "Send October invoices"   # a task that isn't for a client
track log globex "Call with client about the launch plan"
track recent --days 7                   # what happened this week
track projects                          # progress per project
track archive initech                   # and: track unarchive initech
track prs                               # open pull requests, by who acts next
track note add acme-co "Their lead reviews on Tuesdays and Thursdays"
track notes acme                        # notes for one project (or all, with no project)
track note pin 3        track note edit 3 "..."        track note rm 3
track help
```

More commands:

```bash
track ls --all                          # also tasks done in the last 14 days
track add acme-co "Fix login" --status doing   # start it straight away
track show 12                           # one task with its notes
track rm 12                             # delete a task
track project add "Acme Co" --color teal
track project rename acme "Acme Corp"   # and: track project color acme rose
track project jira acme-co acme.atlassian.net   # where the auto-update reads tickets (none clears it)
track project linear globex "Globex"
track runs                              # the last 10 auto-update runs, with cost
track state                             # everything the page sees, as JSON
```

`track help` lists every command and option. A project can be named by its full name, its repo folder name
(`acme-co`), part of the name (`acme`), or its id. Add `--json` to `ls`, `recent`, `projects`, `show`, `notes`
and `prs` for machine-readable output.

## Auto-update

`scripts/auto-update.js` runs Claude Code headlessly every 30 minutes, Monday to Friday, from 09:00 to
19:00. launchd starts it on the hour and half hour while the Mac is awake, and the script skips the times
outside that window. A slot missed while the Mac slept runs on wake if it's still within that half hour,
otherwise it waits for the next one.
Each run does two things:

- **Syncs tickets assigned to you** from each project's Jira site or Linear team. Open tickets become
  tasks, and a task moves when its ticket's status changes. In review or ready to test means Waiting,
  and Done means Done. Backlog and Triage tickets aren't added. Your own moves on the board stick until
  the ticket moves again. A task never leaves Done automatically, and a ticket task you delete stays
  deleted. These rules live in `syncTicket` in `lib/store.js`, not in the prompt.
  Where to read tickets is stored on each project in the database, not in the repo. Set it in the
  project dialog or with `track project jira <project> acme.atlassian.net` and
  `track project linear <project> "<team name>"` (`none` clears either one).
- **Logs today's work**, using the same sources as `/daily-status` (commits, PRs, Claude Code sessions).
  You get one short entry per piece of work per day, refined on each run instead of duplicated.
  Entries show an `auto` tag in the feed.

Each run can only use the tracker commands, the local gather script and two read-only ticket searches
(`--permission-mode dontAsk`). It costs at most $1, and it isn't saved as a Claude Code session, so it
doesn't show up in `/daily-status`. The top bar shows the last run. Hover it for the summary and cost.

```bash
npm run auto:install     # install or update the launchd job (re-run after switching Node versions)
npm run auto:run         # run once now, ignoring working hours
npm run auto:uninstall   # remove the job
track runs               # the last 10 runs, with cost
```

The schedule (days, hours, how often) is in `lib/schedule.js`. The other settings (model, budget, whether
ticket Done moves tasks to Done) are in `CONFIG` at the top of `scripts/auto-update.js`, and the instructions Claude gets are in `scripts/auto-update-prompt.md`. Its ticket step is filled in from
the projects' Jira sites and Linear teams on each run.
The log is at `~/Library/Logs/project-tracking/auto-update.log`.

## Claude reviews

The server runs your `/code-review` skill (`~/.claude/skills/code-review`) with the latest Opus
(`claude -p --model opus`) on the PRs waiting for your review:

- by itself, at the same times as the auto-update: every 30 minutes on weekdays from 09:00 to 19:00. A slot
  missed while the Mac slept runs on wake if it's still within that half hour. The PR section shows the next run.
- now, for every PR waiting on you, with **Run reviews** in the PR section.
- for one PR, with **Review with Claude** on its card.

The card in **Review requested** shows the progress and then the verdict, e.g. "Claude: Wouldn't merge yet".
Click it to read the review and decide what to do:

- **Comment**, **Request changes** or **Approve** posts the review to GitHub as you. Each button asks once more
  before it posts. As your skill's "Posting to GitHub" section says, each finding goes on its own line of the
  diff:
  - The text box holds the review's own comment: the verdict, plus any finding on code the PR doesn't change.
  - **On their lines** lists the other findings, one comment each, on the line Claude found it. Edit any of
    them, or **Leave out** the ones you don't want to post.
  - The "what the change does" summary stays on the page, because the author knows what they wrote. So do
    Claude's notes for you (**Only for you, not posted**), such as what it couldn't check or a remark about
    your own branches.
- When the verdict is "Looks good", **Approve** becomes two buttons: **Approve with comment** posts the text
  box and the line comments with the approval, and **Just approve** approves with no text and no comments.
- **Review again** runs a fresh review on the PR's latest commit. **Dismiss** greys out the verdict. **Copy**
  copies the whole review.

Line comments go on the commit Claude reviewed, so they stay on the right lines even after a push. GitHub only
takes a comment on a line that's in the PR's diff, and refuses the whole review over one that isn't. The server
checks each one against the diff, both when the review finishes and again before posting. A finding Claude put
on any other line moves into the text box with its `path:line`. Reviews written before line comments existed are
split up when the server starts: each `` `path:line` — … `` finding whose line is in the diff becomes a line
comment.

How it runs:

- Each PR is reviewed once per head commit. A push after the review marks it "new commits since", and the
  next run reviews the new commit. A run skips PRs that already have a review of their latest commit, and
  PRs untouched for 90+ days, so running it again costs nothing. Reviews run one at a time.
- A review runs in the repo's clone in `~/Desktop/repos` when there is one, so it can read the code around the
  diff (the clone may be on another branch), otherwise from `gh pr diff` alone.
- The run is read-only. It may use `gh pr view`, `gh pr diff`, read-only `git` and the file tools, and nothing
  else. It can't post to GitHub or read `.env` files. Only the buttons above post anything. It returns the
  review as structured output (summary, verdict, text, line comments, notes) instead of a chat message.
- A review has no spending limit, only a 15-minute timeout. A review of a large PR took about 4 minutes and
  cost $2-4. The dialog shows each review's model, time and cost. A review cut off by a server restart
  shows as failed with **Try again**, rather than running again by itself. Stopping the server stops a review in progress.
- Like the auto-update, these runs aren't saved as Claude Code sessions, so they don't show up in
  `/daily-status`.

Settings (model, timeout) are at the top of `lib/review.js`. The schedule is in `lib/schedule.js`, next to
the auto-update's and the daily status's. The server runs
`~/.local/bin/claude` unless `CLAUDE_BIN` is set.

## Daily status

The server runs your `/daily-status` skill (`~/.claude/skills/daily-status`) with Sonnet and shows the result at
the top of each day in **What I did**:

- by itself, every 2 hours on weekdays: 09:00, 11:00, 13:00, 15:00, 17:00 and 19:00 (`EVERY.daily` in
  `lib/schedule.js`). Each slot rewrites today's status once, even if the server restarts during it. The first slot of a day
  also rewrites the last day before it once more, if that one was written before the day ended, so work
  after 19:00 makes it in.
- for any day, with **Write status** (or **Update**) next to its heading. That's also how you fill in days
  from before this existed.

The run is read-only. It may run the skill's gather script and read Jira and Confluence, nothing else, and it
returns the lists as structured output. Each list is matched to a project through its repo folder, so the
project filter applies. Nothing is sent anywhere: **Copy** is how a list leaves the page. A run stops at $1
or 10 minutes, runs one at a time, and isn't saved as a Claude Code session. A failed run keeps the day's
last lists and shows why it failed. Hover the "Written" time for the model and cost. Settings are at the
top of `lib/daily.js`.

## Troubleshooting

- **"Can't reach Postgres"**: Postgres isn't running. Start it with `brew services start postgresql@18`, or set
  `DATABASE_URL` if yours runs elsewhere.
- **"The database ... doesn't exist yet"**: run `npm run setup`.
- **`EADDRINUSE` when starting**: something else is on port 4567, often a server you started earlier.
  Stop that one (`lsof -i :4567` shows it) or set `PORT`.
- **The page shows an error in the pull request section**: `gh` is missing or signed out. Run `gh auth login`.
  The rest of the page works without it.
- **A project shows no PRs, or the auto-update created a duplicate project**: its name doesn't match the repo
  folder. See [how projects are matched](#how-projects-are-matched-to-your-repos).
- **"This server only answers on localhost"**: open http://localhost:4567, not your machine's network address
  or a tunnel. The server refuses anything else on purpose.
- **The auto-update didn't run**: check `~/Library/Logs/project-tracking/auto-update.log` (and `launchd.log`
  next to it), and `track runs`. It only runs on weekdays from 09:00 to 19:00 while the Mac is awake. After
  switching Node versions or moving the repo, run `npm run auto:install` again.
- **A review or daily status failed**: the review's dialog or the day's heading says why. **Try again** runs
  it again. The server's terminal has the full error.

## Data

Tables are defined in `db/schema.sql` and applied on every start:

- `projects`: name, color, `archived_at` (null while in use), `is_common` (true for Common only),
  `jira_site` and `linear_team` (where the auto-update reads its tickets)
- `tasks`: title, status (`todo`, `doing`, `waiting`, `done`), priority, due date, link, notes, `done_at`
- `activity`: every status change, written automatically, plus actions you log by hand
  (`kind = 'logged'`). `source` is `manual` or `auto`; `ref` keys auto-update entries.
- `notes`: sidebar notes, each with a project, `pinned`, and `created_at`/`updated_at`
- `ignored_links`: ticket links whose task you deleted, so the auto-update leaves them out
- `auto_runs`: one row per auto-update run, with its summary and cost
- `pr_reviews`: Claude's review of each PR head commit that waited for your review, with its cost and
  what you posted. `draft` holds it split up for posting (text, line comments, notes). The PRs themselves
  aren't stored.
- `daily_statuses`: Claude's `/daily-status` for each day, as one list of bullets per project, with its
  model and cost
