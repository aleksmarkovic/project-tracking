import { pool, withTransaction } from './db.js';

export const STATUSES = ['todo', 'doing', 'waiting', 'done'];
export const PRIORITIES = ['high', 'normal', 'low'];
export const COLORS = ['indigo', 'teal', 'amber', 'rose', 'violet', 'sky', 'lime', 'slate'];

// Which activity row a status change writes.
const STATUS_ACTIVITY = { todo: 'reopened', doing: 'started', waiting: 'waiting', done: 'done' };

// Done tasks stay in the state payload this long, for the board's Done lane and weekly counts.
const DONE_WINDOW_DAYS = 30;
const ACTIVITY_WINDOW_DAYS = 60;

export class InputError extends Error {}
export class NotFoundError extends Error {}

function text(value, field, { required = false, max = 500 } = {}) {
  if (value == null) {
    if (required) throw new InputError(`${field} is required`);
    return undefined;
  }
  const result = String(value).trim();
  if (required && !result) throw new InputError(`${field} is required`);
  if (result.length > max) throw new InputError(`${field} is too long (max ${max} characters)`);
  return result;
}

function oneOf(value, allowed, field) {
  if (value == null) return undefined;
  if (!allowed.includes(value)) throw new InputError(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

function dateOrNull(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const [y, m, d] = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').map(Number) : [];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (!y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
    throw new InputError(`${field} must be a real date like 2026-10-20`);
  }
  return value;
}

function link(value) {
  const result = text(value, 'Link', { max: 1000 });
  if (result && !/^https?:\/\//i.test(result)) throw new InputError('Link must start with http:// or https://');
  return result;
}

function id(value, field) {
  const result = Number(value);
  if (!Number.isInteger(result) || result <= 0) throw new InputError(`Pick a ${field.toLowerCase()}`);
  return result;
}

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// A Jira site as its bare host. Accepts a pasted URL ("https://acme.atlassian.net/browse/X-1").
// "" or null clears it.
function jiraSite(value) {
  if (value === undefined) return undefined;
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'none') return null;
  const host = raw.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new InputError('Jira site must look like acme.atlassian.net');
  return host;
}

function linearTeam(value) {
  if (value === undefined) return undefined;
  const team = text(value ?? '', 'Linear team', { max: 80 });
  return team && team.toLowerCase() !== 'none' ? team : null;
}

function rethrowDuplicateName(err, name) {
  if (err.code === '23505') throw new InputError(`There's already a project called "${name}"`);
  throw err;
}

// Projects

const PROJECT_SELECT = `
  select p.*,
         count(t.id) filter (where t.status <> 'done')::int    as open_count,
         count(t.id) filter (where t.status = 'doing')::int    as doing_count,
         count(t.id) filter (where t.status = 'waiting')::int  as waiting_count,
         count(t.id) filter (where t.status = 'done')::int     as done_count,
         count(t.id)::int                                      as total_count,
         (select max(a.at) from activity a where a.project_id = p.id) as last_activity_at
    from projects p
    left join tasks t on t.project_id = p.id`;

export async function listProjects({ archived } = {}) {
  const where = archived === undefined ? '' : `where p.archived_at is ${archived ? 'not null' : 'null'}`;
  const { rows } = await pool.query(
    `${PROJECT_SELECT} ${where} group by p.id order by p.archived_at is not null, p.is_common desc, lower(p.name)`,
  );
  return rows;
}

// Resolves a project from an id, its name, its slug ("acme-co"), or a unique prefix or
// fragment of the name ("acme"). "common" always finds the Common project, even after a rename.
export async function findProject(ref) {
  const key = String(ref ?? '').trim().toLowerCase();
  if (!key) throw new InputError('Name a project');
  const { rows } = await pool.query('select * from projects order by archived_at is not null, is_common desc, lower(name)');
  if (/^\d+$/.test(key)) {
    const byId = rows.find((p) => p.id === Number(key));
    if (byId) return byId;
  }
  if (key === 'common') {
    const common = rows.find((p) => p.is_common);
    if (common) return common;
  }
  const exact = rows.find((p) => p.name.toLowerCase() === key || slugify(p.name) === slugify(key));
  if (exact) return exact;
  const keySlug = slugify(key);
  let matches = rows.filter((p) => slugify(p.name).startsWith(keySlug));
  if (!matches.length) matches = rows.filter((p) => slugify(p.name).includes(keySlug));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new InputError(`"${ref}" matches ${matches.map((p) => p.name).join(', ')}. Be more specific.`);
  }
  throw new NotFoundError(`No project called "${ref}". Projects: ${rows.map((p) => p.name).join(', ') || 'none yet'}`);
}

export async function createProject(input) {
  const name = text(input.name, 'Name', { required: true, max: 80 });
  let color = oneOf(input.color, COLORS, 'Color');
  if (!color) {
    const { rows } = await pool.query('select color from projects where archived_at is null');
    const used = new Set(rows.map((r) => r.color));
    color = COLORS.find((c) => !used.has(c)) ?? COLORS[rows.length % COLORS.length];
  }
  try {
    const { rows } = await pool.query(
      'insert into projects (name, color, jira_site, linear_team) values ($1, $2, $3, $4) returning *',
      [name, color, jiraSite(input.jira_site) ?? null, linearTeam(input.linear_team) ?? null],
    );
    return rows[0];
  } catch (err) {
    rethrowDuplicateName(err, name);
  }
}

export async function updateProject(projectId, input) {
  const sets = [];
  const values = [];
  const name = text(input.name, 'Name', { required: input.name !== undefined, max: 80 });
  if (name !== undefined) {
    values.push(name);
    sets.push(`name = $${values.length}`);
  }
  const color = oneOf(input.color, COLORS, 'Color');
  if (color !== undefined) {
    values.push(color);
    sets.push(`color = $${values.length}`);
  }
  for (const [column, value] of [['jira_site', jiraSite(input.jira_site)], ['linear_team', linearTeam(input.linear_team)]]) {
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (input.archived !== undefined) {
    sets.push(input.archived ? 'archived_at = coalesce(archived_at, now())' : 'archived_at = null');
  }
  if (!sets.length) throw new InputError('Nothing to update');
  values.push(projectId);
  const guard = input.archived ? ' and not is_common' : '';
  try {
    const { rows } = await pool.query(
      `update projects set ${sets.join(', ')} where id = $${values.length}${guard} returning *`,
      values,
    );
    if (!rows[0]) await throwProjectGuard(projectId, 'archived');
    return rows[0];
  } catch (err) {
    rethrowDuplicateName(err, name);
  }
}

export async function deleteProject(projectId) {
  const { rowCount } = await pool.query('delete from projects where id = $1 and not is_common', [projectId]);
  if (!rowCount) await throwProjectGuard(projectId, 'deleted');
  return { deleted: projectId };
}

// Explains why an update or delete matched no row: the project is gone, or it's Common.
async function throwProjectGuard(projectId, verb) {
  const { rows: [project] } = await pool.query('select name, is_common from projects where id = $1', [projectId]);
  if (!project) throw new NotFoundError('Project not found');
  if (project.is_common) throw new InputError(`${project.name} can't be ${verb}. It holds tasks that don't belong to a client.`);
  throw new NotFoundError('Project not found');
}

// Tasks

const TASK_ORDER = `case t.priority when 'high' then 0 when 'normal' then 1 else 2 end, t.due_date nulls last, t.created_at`;

export async function listTasks({ projectId, includeArchived = false, doneSince } = {}) {
  const where = [];
  const values = [];
  if (projectId) {
    values.push(projectId);
    where.push(`t.project_id = $${values.length}`);
  }
  if (!includeArchived) where.push('p.archived_at is null');
  if (doneSince === null) where.push(`t.status <> 'done'`);
  else if (doneSince) {
    values.push(doneSince);
    where.push(`(t.status <> 'done' or t.done_at >= $${values.length})`);
  }
  const { rows } = await pool.query(
    `select t.*, p.name as project_name, p.color as project_color
       from tasks t join projects p on p.id = t.project_id
       ${where.length ? `where ${where.join(' and ')}` : ''}
      order by ${TASK_ORDER}`,
    values,
  );
  return rows;
}

export async function getTask(taskId) {
  const { rows } = await pool.query(
    `select t.*, p.name as project_name, p.color as project_color
       from tasks t join projects p on p.id = t.project_id where t.id = $1`,
    [taskId],
  );
  if (!rows[0]) throw new NotFoundError(`Task #${taskId} not found`);
  return rows[0];
}

// Adding a task to an archived project brings the project back, so the task shows on the board.
// `source` is 'auto' for changes made by the auto-update. A task added straight into another
// lane also records that move ("Started ..."), unless `logStatus` is false.
export async function createTask(input, { source = 'manual', logStatus = true } = {}) {
  const title = text(input.title, 'Title', { required: true, max: 300 });
  const projectId = id(input.project_id, 'Project');
  const status = oneOf(input.status, STATUSES, 'Status') ?? 'todo';
  const priority = oneOf(input.priority, PRIORITIES, 'Priority') ?? 'normal';
  const dueDate = dateOrNull(input.due_date, 'Due date') ?? null;
  const notes = text(input.notes, 'Notes', { max: 5000 }) ?? '';
  const url = link(input.link) ?? '';
  const externalStatus = text(input.external_status, 'Ticket status', { max: 100 }) ?? null;

  return withTransaction(async (db) => {
    const { rows: [project] } = await db.query('select archived_at from projects where id = $1 for update', [projectId]);
    if (!project) throw new InputError('That project no longer exists');
    if (project.archived_at) await db.query('update projects set archived_at = null where id = $1', [projectId]);
    const { rows: [task] } = await db.query(
      `insert into tasks (project_id, title, notes, link, status, priority, due_date, external_status, done_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, case when $5::text = 'done' then now() end)
       returning *`,
      [projectId, title, notes, url, status, priority, dueDate, externalStatus],
    );
    await db.query(
      `insert into activity (project_id, task_id, kind, text, source) values ($1, $2, 'created', $3, $4)`,
      [projectId, task.id, title, source],
    );
    if (status !== 'todo' && logStatus) {
      await db.query(
        `insert into activity (project_id, task_id, kind, text, source) values ($1, $2, $3, $4, $5)`,
        [projectId, task.id, STATUS_ACTIVITY[status], title, source],
      );
    }
    return { ...task, restored_project: Boolean(project.archived_at) };
  });
}

export async function updateTask(taskId, input, { source = 'manual' } = {}) {
  return withTransaction(async (db) => {
    const { rows: [current] } = await db.query('select * from tasks where id = $1 for update', [taskId]);
    if (!current) throw new NotFoundError(`Task #${taskId} not found`);

    const sets = [];
    const values = [];
    const set = (column, value) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (input.title !== undefined) set('title', text(input.title, 'Title', { required: true, max: 300 }));
    if (input.notes !== undefined) set('notes', text(input.notes, 'Notes', { max: 5000 }) ?? '');
    if (input.link !== undefined) set('link', link(input.link) ?? '');
    if (input.priority !== undefined) set('priority', oneOf(input.priority, PRIORITIES, 'Priority'));
    if (input.due_date !== undefined) set('due_date', dateOrNull(input.due_date, 'Due date'));
    if (input.project_id !== undefined) set('project_id', id(input.project_id, 'Project'));
    if (input.external_status !== undefined) {
      set('external_status', text(input.external_status, 'Ticket status', { max: 100 }) || null);
    }
    const status = oneOf(input.status, STATUSES, 'Status');
    const statusChanged = status !== undefined && status !== current.status;
    if (statusChanged) {
      set('status', status);
      sets.push(status === 'done' ? 'done_at = now()' : 'done_at = null');
    }
    if (!sets.length) return current;

    sets.push('updated_at = now()');
    values.push(taskId);
    const { rows: [task] } = await db.query(
      `update tasks set ${sets.join(', ')} where id = $${values.length} returning *`,
      values,
    );
    if (statusChanged) {
      await db.query(
        `insert into activity (project_id, task_id, kind, text, source) values ($1, $2, $3, $4, $5)`,
        [task.project_id, task.id, STATUS_ACTIVITY[status], task.title, source],
      );
    }
    return task;
  }).catch((err) => {
    if (err.code === '23503') throw new InputError('That project no longer exists');
    throw err;
  });
}

// Deleting a task that came from a ticket also stops the auto-update from adding it back.
export async function deleteTask(taskId) {
  return withTransaction(async (db) => {
    const { rows: [task] } = await db.query('delete from tasks where id = $1 returning link', [taskId]);
    if (!task) throw new NotFoundError(`Task #${taskId} not found`);
    if (task.link) {
      await db.query('insert into ignored_links (link) values ($1) on conflict do nothing', [task.link]);
    }
    return { deleted: taskId, ignored_link: task.link || null };
  });
}

export async function findTaskByLink(url) {
  const { rows } = await pool.query(
    `select t.*, p.name as project_name, p.archived_at as project_archived_at
       from tasks t join projects p on p.id = t.project_id
      where t.link = $1 order by t.id limit 1`,
    [url],
  );
  return rows[0] ?? null;
}

// Tickets (Jira, Linear)

// The projects whose assigned tickets the auto-update reads, with the slug it passes back as `project`.
export async function listTicketSources() {
  const { rows } = await pool.query(
    `select id, name, jira_site, linear_team from projects
      where jira_site is not null or linear_team is not null order by lower(name)`,
  );
  return rows.map((p) => ({ ...p, slug: slugify(p.name) }));
}

// Ticket state → board lane. Jira sends its status category, Linear its state type.
const TICKET_STATES = {
  new: 'todo',
  indeterminate: 'doing',
  done: 'done',
  triage: 'todo',
  backlog: 'todo',
  unstarted: 'todo',
  started: 'doing',
  completed: 'done',
  canceled: null,
};
// In-progress statuses that mean the ball is in someone else's court.
const WAITING_STATUS = /review|test|qa|block|wait|approv/i;
// Tickets parked here aren't planned work yet, so they're not added to the board.
const PARKED_STATUS = /backlog|triage/i;

/*
 * Brings one assigned ticket onto the board, or moves its task when the ticket's status changed
 * since the last sync. A task never leaves Done this way, and moves made by hand stick until the
 * ticket itself moves again. Returns { action } as one of: added, moved, noted, unchanged, skipped.
 */
export async function syncTicket(input, { allowDone = true } = {}) {
  const url = link(input.link);
  if (!url) throw new InputError('Ticket link is required');
  const externalStatus = text(input.status, 'Ticket status', { required: true, max: 100 });
  const state = String(input.state ?? '').toLowerCase();
  if (!(state in TICKET_STATES)) {
    throw new InputError(`Ticket state must be one of: ${Object.keys(TICKET_STATES).join(', ')}`);
  }
  let target = TICKET_STATES[state];
  if (target === 'doing' && WAITING_STATUS.test(externalStatus)) target = 'waiting';
  if (target === 'done' && !allowDone) target = null;

  const existing = await findTaskByLink(url);
  if (!existing) {
    const { rowCount: ignored } = await pool.query('select 1 from ignored_links where link = $1', [url]);
    if (ignored) return { action: 'skipped', reason: 'deleted by hand before' };
    if (!target || target === 'done') return { action: 'skipped', reason: `ticket is ${externalStatus}` };
    if (state === 'backlog' || state === 'triage' || PARKED_STATUS.test(externalStatus)) {
      return { action: 'skipped', reason: `ticket is in ${externalStatus}` };
    }
    const project = await findProject(input.project);
    if (project.archived_at) return { action: 'skipped', reason: `${project.name} is archived` };
    // A ticket that was already in progress when it first shows up wasn't started just now, so
    // only its creation is recorded.
    const task = await createTask(
      { project_id: project.id, title: input.title, link: url, status: target, external_status: externalStatus },
      { source: 'auto', logStatus: false },
    );
    return { action: 'added', task };
  }

  if (existing.external_status === externalStatus) return { action: 'unchanged', task: existing };
  const status = existing.status !== 'done' && target ? target : existing.status;
  const task = await updateTask(existing.id, { status, external_status: externalStatus }, { source: 'auto' });
  return { action: status === existing.status ? 'noted' : 'moved', task, from: existing.status };
}

// Activity

export async function listActivity({ since, projectId, limit = 500 } = {}) {
  const where = [];
  const values = [];
  if (since) {
    values.push(since);
    where.push(`a.at >= $${values.length}`);
  }
  if (projectId) {
    values.push(projectId);
    where.push(`a.project_id = $${values.length}`);
  }
  values.push(limit);
  const { rows } = await pool.query(
    `select a.*, p.name as project_name, p.color as project_color
       from activity a join projects p on p.id = a.project_id
       ${where.length ? `where ${where.join(' and ')}` : ''}
      order by a.at desc, a.id desc
      limit $${values.length}`,
    values,
  );
  return rows;
}

// With a `ref`, logging again updates that entry (text and time) instead of adding a second one.
// Returns the entry with `result` set to added, updated or unchanged.
export async function logAction(input, { source = 'manual' } = {}) {
  const projectId = id(input.project_id, 'Project');
  const entry = text(input.text, 'What you did', { required: true, max: 500 });
  const ref = text(input.ref, 'Ref', { max: 200 }) || null;
  try {
    const { rows } = await pool.query(
      `insert into activity (project_id, kind, text, source, ref) values ($1, 'logged', $2, $3, $4)
       on conflict (ref) do update
         set text = excluded.text, project_id = excluded.project_id, at = now()
         where activity.text is distinct from excluded.text or activity.project_id <> excluded.project_id
       returning *, (xmax = 0) as inserted`,
      [projectId, entry, source, ref],
    );
    if (!rows[0]) {
      const { rows: [same] } = await pool.query('select * from activity where ref = $1', [ref]);
      return { ...same, result: 'unchanged' };
    }
    const { inserted, ...row } = rows[0];
    return { ...row, result: inserted ? 'added' : 'updated' };
  } catch (err) {
    if (err.code === '23503') throw new InputError('That project no longer exists');
    throw err;
  }
}

export async function deleteActivity(activityId) {
  const { rowCount } = await pool.query('delete from activity where id = $1', [activityId]);
  if (!rowCount) throw new NotFoundError('Entry not found');
  return { deleted: activityId };
}

// Auto-update runs

const AUTO_RUNS_KEPT = 500;

export async function recordAutoRun({ startedAt, ok, summary, costUsd }) {
  await pool.query(
    'insert into auto_runs (started_at, ok, summary, cost_usd) values ($1, $2, $3, $4)',
    [startedAt, ok, String(summary ?? '').slice(0, 1000), costUsd ?? null],
  );
  await pool.query(
    'delete from auto_runs where id not in (select id from auto_runs order by id desc limit $1)',
    [AUTO_RUNS_KEPT],
  );
}

export async function listAutoRuns({ limit = 10 } = {}) {
  const { rows } = await pool.query('select * from auto_runs order by started_at desc limit $1', [limit]);
  return rows;
}

// Everything the page needs in one payload.
// Notes

// Pinned first, then the most recently written. Notes of archived projects are left out, like
// their tasks, unless asked for by project.
export async function listNotes({ projectId, includeArchived = false } = {}) {
  const where = [];
  const values = [];
  if (projectId) {
    values.push(projectId);
    where.push(`n.project_id = $${values.length}`);
  }
  if (!includeArchived) where.push('p.archived_at is null');
  const { rows } = await pool.query(
    `select n.*, p.name as project_name, p.color as project_color
       from notes n join projects p on p.id = n.project_id
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by n.pinned desc, n.updated_at desc, n.id desc`,
    values,
  );
  return rows;
}

export async function getNote(noteId) {
  const { rows: [note] } = await pool.query(
    `select n.*, p.name as project_name, p.color as project_color
       from notes n join projects p on p.id = n.project_id where n.id = $1`,
    [noteId],
  );
  if (!note) throw new NotFoundError(`Note #${noteId} not found`);
  return note;
}

export async function createNote(input) {
  const body = text(input.body, 'Note', { required: true, max: 10_000 });
  const projectId = id(input.project_id, 'Project');
  try {
    const { rows: [note] } = await pool.query(
      'insert into notes (project_id, body, pinned) values ($1, $2, $3) returning *',
      [projectId, body, input.pinned === true],
    );
    return note;
  } catch (err) {
    if (err.code === '23503') throw new InputError('That project no longer exists');
    throw err;
  }
}

export async function updateNote(noteId, input) {
  const sets = [];
  const values = [];
  const set = (column, value) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (input.body !== undefined) set('body', text(input.body, 'Note', { required: true, max: 10_000 }));
  if (input.project_id !== undefined) set('project_id', id(input.project_id, 'Project'));
  if (sets.length) sets.push('updated_at = now()');
  if (input.pinned !== undefined) {
    if (typeof input.pinned !== 'boolean') throw new InputError('Pinned must be true or false');
    set('pinned', input.pinned);
  }
  if (!sets.length) throw new InputError('Nothing to update');
  values.push(noteId);
  try {
    const { rows: [note] } = await pool.query(
      `update notes set ${sets.join(', ')} where id = $${values.length} returning *`,
      values,
    );
    if (!note) throw new NotFoundError(`Note #${noteId} not found`);
    return note;
  } catch (err) {
    if (err.code === '23503') throw new InputError('That project no longer exists');
    throw err;
  }
}

export async function deleteNote(noteId) {
  const { rowCount } = await pool.query('delete from notes where id = $1', [noteId]);
  if (!rowCount) throw new NotFoundError(`Note #${noteId} not found`);
  return { deleted: noteId };
}

// Pull request reviews (run by lib/review.js)

export const REVIEW_EVENTS = ['comment', 'approve', 'request_changes'];

// The latest review of each PR, newest first.
export async function listReviews() {
  const { rows } = await pool.query('select distinct on (url) * from pr_reviews order by url, created_at desc, id desc');
  return rows;
}

export async function getReview(reviewId) {
  const { rows: [review] } = await pool.query('select * from pr_reviews where id = $1', [reviewId]);
  if (!review) throw new NotFoundError(`Review #${reviewId} not found`);
  return review;
}

// Queues a review of the PR's current head commit. A head that already has a review is left alone,
// unless `again` asks for a fresh one; that returns null while the review is still running.
export async function queueReview(pr, { again = false } = {}) {
  const onConflict = again
    ? `update set status = 'queued', title = excluded.title, body = '', error = null, model = null, cost_usd = null,
         created_at = now(), started_at = null, finished_at = null, dismissed_at = null, posted_as = null, posted_at = null,
         draft = null
       where pr_reviews.status <> 'running'`
    : 'nothing';
  const { rows: [review] } = await pool.query(
    `insert into pr_reviews (url, head_sha, title) values ($1, $2, $3)
     on conflict (url, head_sha) do ${onConflict} returning *`,
    [pr.url, pr.head_sha, pr.title],
  );
  // A queued review of an older commit would be out of date before it starts.
  await pool.query("delete from pr_reviews where url = $1 and head_sha <> $2 and status = 'queued'", [pr.url, pr.head_sha]);
  return review ?? null;
}

export async function deleteReview(reviewId) {
  await pool.query('delete from pr_reviews where id = $1', [reviewId]);
}

// Drops queued reviews of PRs that no longer wait for the user (reviewed, merged or closed).
export async function dropQueuedReviews(waitingUrls) {
  await pool.query("delete from pr_reviews where status = 'queued' and not (url = any($1))", [waitingUrls]);
}

// Takes the oldest queued review and marks it running.
export async function startNextReview() {
  const { rows: [review] } = await pool.query(
    `update pr_reviews set status = 'running', started_at = now()
      where id = (select id from pr_reviews where status = 'queued' order by created_at, id limit 1)
      returning *`,
  );
  return review ?? null;
}

export async function finishReview(reviewId, { body, draft, model, costUsd }) {
  await pool.query(
    "update pr_reviews set status = 'done', body = $2, draft = $3, model = $4, cost_usd = $5, finished_at = now() where id = $1",
    [reviewId, body, draft ? JSON.stringify(draft) : null, model, costUsd ?? null],
  );
}

// Finished reviews written before inline comments that could still be posted, so lib/review.js can
// split them up.
export async function listUnsplitReviews() {
  const { rows } = await pool.query(
    "select * from pr_reviews where status = 'done' and draft is null and posted_as is null and dismissed_at is null",
  );
  return rows;
}

export async function setReviewDraft(reviewId, draft) {
  await pool.query('update pr_reviews set draft = $2 where id = $1 and draft is null', [reviewId, JSON.stringify(draft)]);
}

export async function failReview(reviewId, { error, costUsd }) {
  await pool.query(
    "update pr_reviews set status = 'failed', error = $2, cost_usd = $3, finished_at = now() where id = $1",
    [reviewId, String(error).slice(0, 1000), costUsd ?? null],
  );
}

// A review still marked running when the server starts was cut off. It isn't retried on its own,
// because each run costs money; the page offers to try again.
export async function failInterruptedReviews() {
  await pool.query(
    "update pr_reviews set status = 'failed', error = 'The server stopped during the review', finished_at = now() where status = 'running'",
  );
}

// { dismissed: true | false }
export async function updateReview(reviewId, input) {
  if (typeof input.dismissed !== 'boolean') throw new InputError('Dismissed must be true or false');
  const { rows: [review] } = await pool.query(
    `update pr_reviews set dismissed_at = ${input.dismissed ? 'coalesce(dismissed_at, now())' : 'null'} where id = $1 returning *`,
    [reviewId],
  );
  if (!review) throw new NotFoundError(`Review #${reviewId} not found`);
  return review;
}

const MAX_REVIEW_COMMENTS = 50;

// { event: 'comment' | 'approve' | 'request_changes', body, comments?: [{ path, line, start_line?, side,
// body }] } → the same, checked. Only an approval may go without text. Each comment goes on a line of
// the diff: `line` (and `start_line` for a block) in the new file, or the old one for side LEFT.
export function reviewPostInput(input) {
  const event = oneOf(input.event, REVIEW_EVENTS, 'Event');
  if (!event) throw new InputError('Pick comment, approve or request changes');
  const body = text(input.body, 'Review', { required: event !== 'approve', max: 60_000 }) ?? '';
  const raw = input.comments ?? [];
  if (!Array.isArray(raw)) throw new InputError('Comments must be a list');
  if (raw.length > MAX_REVIEW_COMMENTS) throw new InputError(`At most ${MAX_REVIEW_COMMENTS} line comments`);
  const comments = raw.map((comment) => {
    if (typeof comment !== 'object' || comment === null) throw new InputError('Each comment needs a path, a line and text');
    const path = text(comment.path, 'Comment path', { required: true, max: 1000 });
    const { line } = comment;
    const startLine = comment.start_line ?? null;
    if (!Number.isInteger(line) || line <= 0) throw new InputError(`The comment on ${path} needs a line number`);
    if (startLine !== null && (!Number.isInteger(startLine) || startLine <= 0 || startLine >= line)) {
      throw new InputError(`The comment on ${path}:${line} starts after it ends`);
    }
    const side = oneOf(comment.side ?? 'RIGHT', ['RIGHT', 'LEFT'], 'Comment side');
    const where = `${path}:${startLine ? `${startLine}-` : ''}${line}`;
    if (typeof comment.body !== 'string' || !comment.body.trim()) throw new InputError(`Write the comment on ${where}, or leave it out`);
    const body = text(comment.body, `The comment on ${where}`, { required: true, max: 20_000 });
    return { path, line, ...(startLine ? { start_line: startLine } : {}), side, body };
  });
  return { event, body, comments };
}

// { url, head_sha } → the same, checked, for merging an approved PR (lib/github.js).
export function mergeInput(input) {
  const url = text(input.url, 'PR url', { required: true, max: 500 });
  if (typeof input.head_sha !== 'string' || !/^[0-9a-f]{40}$/.test(input.head_sha)) {
    throw new InputError('head_sha must be the full SHA of the commit you saw');
  }
  return { url, headSha: input.head_sha };
}

export async function recordReviewPosted(reviewId, event) {
  const { rows: [review] } = await pool.query(
    'update pr_reviews set posted_as = $2, posted_at = now() where id = $1 returning *',
    [reviewId, event],
  );
  if (!review) throw new NotFoundError(`Review #${reviewId} not found`);
  return review;
}

// Daily statuses (written by lib/daily.js)

// A 'YYYY-MM-DD' day that has started, for writing its status.
export function statusDay(value) {
  const day = dateOrNull(value, 'Day');
  if (!day) throw new InputError('Name a day like 2026-10-20');
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (day > today) throw new InputError("That day hasn't happened yet");
  return day;
}

// Newest first. With `before`, only days before that one.
export async function listDailyStatuses({ sinceDays, before, limit = 100 } = {}) {
  const where = [];
  const values = [];
  if (sinceDays) {
    values.push(sinceDays);
    where.push(`day >= current_date - $${values.length}::int`);
  }
  if (before) {
    values.push(before);
    where.push(`day < $${values.length}`);
  }
  values.push(limit);
  const { rows } = await pool.query(
    `select * from daily_statuses ${where.length ? `where ${where.join(' and ')}` : ''} order by day desc limit $${values.length}`,
    values,
  );
  return rows;
}

// Marks the day's status as being written. Its last lists stay until the new ones are in.
export async function startDailyStatus(day) {
  const { rows: [row] } = await pool.query(
    `insert into daily_statuses (day) values ($1)
     on conflict (day) do update set status = 'running', error = null, started_at = now()
     returning *`,
    [day],
  );
  return row;
}

export async function finishDailyStatus(day, { lists, note, body, model, costUsd }) {
  await pool.query(
    `update daily_statuses set status = 'done', lists = $2, note = $3, body = $4, model = $5, cost_usd = $6,
       finished_at = now() where day = $1`,
    [day, JSON.stringify(lists), note, body, model, costUsd ?? null],
  );
}

export async function failDailyStatus(day, error) {
  await pool.query("update daily_statuses set status = 'failed', error = $2 where day = $1", [day, String(error).slice(0, 1000)]);
}

// A status still marked as being written when the server starts was cut off. The next slot or a
// click writes it again.
export async function failInterruptedDailyStatuses() {
  await pool.query(
    "update daily_statuses set status = 'failed', error = 'The server stopped while Claude was writing it' where status = 'running'",
  );
}

export async function getState() {
  const now = Date.now();
  const [projects, tasks, activity, notes, [autoRun], dailyStatuses] = await Promise.all([
    listProjects(),
    listTasks({ doneSince: new Date(now - DONE_WINDOW_DAYS * 86_400_000) }),
    listActivity({ since: new Date(now - ACTIVITY_WINDOW_DAYS * 86_400_000) }),
    listNotes(),
    listAutoRuns({ limit: 1 }),
    listDailyStatuses({ sinceDays: ACTIVITY_WINDOW_DAYS }),
  ]);
  return { projects, tasks, activity, notes, autoRun: autoRun ?? null, dailyStatuses };
}
