# Client Workbench

Personal tracker for client work. Node (ESM, no framework) + Postgres via `pg`; plain HTML/CSS/JS front end in `public/`.

- `lib/store.js` holds every query and all validation. The server (`server.js`) and the CLI (`bin/track.js`) both call it, so put new behaviour there.
- `db/schema.sql` runs on every server start and on `npm run setup`. Every statement must be idempotent (`create ... if not exists`, guarded `alter`s).
- Status changes write `activity` rows inside the same transaction. Keep it that way, because the "What I did" feed and chart read from `activity`.
- Ticket sync rules (what gets added, when a task moves) live in `syncTicket` in `lib/store.js`. Keep them out of `scripts/auto-update-prompt.md`, which only tells the scheduled run what to read and how to summarise work.
- No client names, Jira sites or Linear teams in the repo. Which tickets the auto-update reads is stored per project (`projects.jira_site`, `projects.linear_team`) and rendered into the prompt's `{{TICKET_SOURCES}}` by `scripts/auto-update.js`. Use made-up names like Acme Co in examples.
- Common (`projects.is_common`) is seeded by the schema and holds tasks that aren't for a client. `lib/store.js` refuses to archive or delete it, `findProject('common')` finds it even after a rename, and the front end checks `is_common`, never the name.
- The front end renders from one `GET /api/state` payload and re-fetches after every change. The one exception is pull requests: `lib/github.js` reads them from GitHub through `gh` (cached for a minute) and serves them at `GET /api/github`, separately because GitHub is slower and can fail on its own. They aren't stored in Postgres. PRs waiting for the user's review get the user's `/code-review` skill run on them by `lib/review.js` (latest Opus, one per head commit, read-only and unable to post) on a schedule (`lib/schedule.js`, which also times the auto-update) or when the user clicks Run reviews (`POST /api/reviews/run`); reading `/api/github` never starts one. The reviews are stored in `pr_reviews` and ride along on `/api/github`. Only the user's click on the page posts a review to GitHub (`POST /api/reviews/:id/post`). A run returns structured output (`SCHEMA` in `lib/review.js`), stored in `pr_reviews.draft`: each finding on a diff line posts as its own comment on that line through `gh api …/pulls/N/reviews`, checked against the diff first, because GitHub refuses the whole review over one comment off the diff. `summary` and `notes` never leave the page. The daily status at the top of each day in "What I did" works the same way: `lib/daily.js` runs the user's `/daily-status` skill (Sonnet, read-only: the skill's gather script and Jira/Confluence reads) on its own interval in `lib/schedule.js` or when the user clicks Write status/Update (`POST /api/daily/:day/run`), and stores one row per day in `daily_statuses` (structured output: one list of bullets per project, matched to a tracker project by folder), which rides along on `/api/state`. It never posts anywhere; Copy is how a list leaves the page. Since a GET can be triggered by any web page, `server.js` refuses API requests whose `Sec-Fetch-Site` is another site, and every request addressed to a non-local host (an ngrok tunnel or a DNS-rebinding page). Keep it local-only. Colors are tokens in `public/styles.css`; project colors are names from `COLORS`, never hex values.

## Updating the tracker for the user

Use the CLI rather than raw SQL:

```bash
node ~/Desktop/repos/project-tracking/bin/track.js <command>
```

- `ls [project] [--json]`, `add <project> <title> [--high|--low] [--due YYYY-MM-DD] [--link URL] [--note ..] [--status doing]`
- `start|wait|done|reopen <id...>`, `edit <id> ...`, `log <project> <text>`, `recent --days N`, `projects`, `archive|unarchive <project>`
- `notes [project]`, `note add <project> <text>`, `note edit|pin|unpin|rm <id>`: the user's sidebar notes. Only write one when the user asks you to note something down.
- Projects can be referenced by repo folder name (`acme-co`). Tasks that aren't for a client go to `common`.
- Log real actions only, written as one short line in the user's words. Don't log trivial actions such as "looked at the code".
