-- Applied on every server start and by `npm run setup`, so every statement must be idempotent.

create table if not exists projects (
  id          serial primary key,
  name        text not null,
  color       text not null default 'slate',
  created_at  timestamptz not null default now(),
  -- null while the project is in use; set when it is archived
  archived_at timestamptz
);

create unique index if not exists projects_name_key on projects (lower(name));

-- Common: the one project for tasks that don't belong to a client. It always exists and can't be
-- archived or deleted, but can be renamed. An existing project named "Common" is adopted first,
-- because the insert would clash with its name.
alter table projects add column if not exists is_common boolean not null default false;
create unique index if not exists projects_one_common on projects (is_common) where is_common;
update projects set is_common = true, archived_at = null
 where lower(name) = 'common' and not exists (select 1 from projects where is_common);
insert into projects (name, color, is_common)
select 'Common', 'slate', true where not exists (select 1 from projects where is_common);

create table if not exists tasks (
  id          serial primary key,
  project_id  integer not null references projects (id) on delete cascade,
  title       text not null,
  notes       text not null default '',
  link        text not null default '',
  status      text not null default 'todo' check (status in ('todo', 'doing', 'waiting', 'done')),
  priority    text not null default 'normal' check (priority in ('high', 'normal', 'low')),
  due_date    date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  done_at     timestamptz
);

create index if not exists tasks_project_idx on tasks (project_id);

-- Everything that happened: task changes are written automatically, `logged` rows are
-- actions entered by hand (a client call, a review, research).
create table if not exists activity (
  id          serial primary key,
  project_id  integer not null references projects (id) on delete cascade,
  task_id     integer references tasks (id) on delete set null,
  kind        text not null check (kind in ('created', 'started', 'waiting', 'done', 'reopened', 'logged')),
  text        text not null,
  at          timestamptz not null default now()
);

create index if not exists activity_at_idx on activity (at desc);
create index if not exists activity_project_idx on activity (project_id);

-- Auto-update (scripts/auto-update.js) ------------------------------------------------------

-- Where the auto-update reads a project's assigned tickets. Both are optional and kept here rather than
-- in the repo, so client names stay out of it. `jira_site` is the Atlassian site (acme.atlassian.net),
-- `linear_team` the Linear team's name.
alter table projects add column if not exists jira_site text;
alter table projects add column if not exists linear_team text;

-- Status of the linked Jira/Linear ticket at the last sync. A task only follows its ticket when the
-- ticket's status changes, so moves made by hand on the board stick.
alter table tasks add column if not exists external_status text;

-- 'manual' or 'auto'. `ref` is a stable key for an automatic log entry (one per piece of work per
-- day); logging the same ref again updates that entry instead of adding another.
alter table activity add column if not exists source text not null default 'manual';
alter table activity add column if not exists ref text;
create unique index if not exists activity_ref_key on activity (ref);

-- Ticket links whose task was deleted by hand, so the sync doesn't add them back.
create table if not exists ignored_links (
  link       text primary key,
  created_at timestamptz not null default now()
);

create table if not exists auto_runs (
  id          serial primary key,
  started_at  timestamptz not null,
  finished_at timestamptz not null default now(),
  ok          boolean not null,
  summary     text not null default '',
  cost_usd    double precision
);

-- Notes ---------------------------------------------------------------------------------------

-- Free-text notes from the sidebar. Each belongs to a project (Common for general notes), and
-- `updated_at` only moves when the text or project changes, not when a note is pinned.
create table if not exists notes (
  id          serial primary key,
  project_id  integer not null references projects (id) on delete cascade,
  body        text not null,
  pinned      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists notes_project_idx on notes (project_id);

-- Pull request reviews (lib/review.js) ---------------------------------------------------------

-- Claude's /code-review of a PR waiting for the user's review, one row per PR head commit. PRs
-- themselves aren't stored; `url` links a row to the PR in the GitHub list. `posted_as` records what
-- the user posted to GitHub from the page.
create table if not exists pr_reviews (
  id           serial primary key,
  url          text not null,
  head_sha     text not null,
  title        text not null default '',
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  body         text not null default '',
  error        text,
  model        text,
  cost_usd     double precision,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  dismissed_at timestamptz,
  posted_as    text check (posted_as in ('comment', 'approve', 'request_changes')),
  posted_at    timestamptz
);

create unique index if not exists pr_reviews_head_key on pr_reviews (url, head_sha);
-- The review split up for posting: { summary, verdict, body, comments: [{ path, line, start_line?, side,
-- body }], notes }. `summary` and `notes` stay on the page; `body` is the review's own text and each
-- comment goes on its line of the diff. Null for reviews written before inline comments, until the
-- server splits their text (lib/review.js).
alter table pr_reviews add column if not exists draft jsonb;

-- Daily statuses (lib/daily.js) ----------------------------------------------------------------

-- The user's /daily-status for a day: what they did, as one short client-ready list per project, written
-- by a headless Claude run. `lists` is [{ project, project_id, name, bullets }]: `project` is the repo
-- folder the skill grouped the work under, `project_id` the tracker project it matched (null when none
-- did) and `name` the client's readable name. `note` is the skill's line under the lists (a source it
-- couldn't check). A run that fails keeps the day's last lists.
create table if not exists daily_statuses (
  day          date primary key,
  status       text not null default 'running' check (status in ('running', 'done', 'failed')),
  lists        jsonb,
  note         text not null default '',
  body         text not null default '',
  error        text,
  model        text,
  cost_usd     double precision,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
