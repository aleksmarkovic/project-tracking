#!/usr/bin/env node
// Terminal access to the tracker. Talks to Postgres directly, so the web server doesn't need to be running.
import { parseArgs } from 'node:util';
import { describeDbError, pool } from '../lib/db.js';
import { PR_GROUPS, STALE_DAYS, getPullRequests } from '../lib/github.js';
import * as store from '../lib/store.js';

const HELP = `Usage: track <command> [options]

Tasks
  ls [project] [--all]            Open tasks, grouped by project (--all adds tasks done in the last 14 days)
  add <project> <title...>        Add a task
      --due 2026-10-20  --high | --low  --note "..."  --link https://...  --status doing
  start|wait|done|reopen <id...>  Move tasks to In progress / Waiting / Done / To do
  edit <id>                       Change a task: --title --due (use "none" to clear) --priority --note --link --project
  show <id>                       Print one task with its notes
  rm <id>                         Delete a task

What you did
  log <project> <text...>         Record something you did (a call, a review, research)
      --ref <key>                 Stable key: logging the same key again updates that entry
  recent [--days 1]               Activity from the last N days (default: today)

Auto-update
  tickets '<json array>'          Sync assigned tickets: [{project, link, title, status, state}]
      --keep-open                 Don't move tasks to Done when their ticket is done
  runs                            The last 10 auto-update runs

Notes
  notes [project]                 Your notes, pinned first
  note add <project> <text...>    Write a note (common for one that isn't about a client)
  note edit <id> <text...>        Replace a note's text
  note pin|unpin <id>             Keep a note at the top
  note rm <id>                    Delete a note

GitHub
  prs                             Open pull requests: reviews asked of you, and your own PRs by state

Projects
  projects [--archived | --all]   Active projects with progress (or archived ones, or both)
  project add <name> [--color teal]
  project rename <project> <new name>
  project color <project> <color> Colors: ${store.COLORS.join(', ')}
  project jira <project> <site>   Jira site the auto-update reads its tickets from (acme.atlassian.net, or none)
  project linear <project> <team> Linear team the auto-update reads its tickets from (or none)
  archive <project>               Hide a project you're not working on (its tasks stay)
  unarchive <project>             Bring it back

  state                           Everything the web page sees, as JSON

<project> can be the name, the repo folder name (acme-co), a unique prefix, or the id.
Use \`common\` for tasks that aren't for a client: track add common "Send October invoices".
Add --json to ls, recent, projects, show, notes and prs for machine-readable output.
Add --auto (or set TRACK_SOURCE=auto) to mark changes as made by the auto-update.`;

const STATUS_LABEL = { todo: 'to do', doing: 'in progress', waiting: 'waiting', done: 'done' };
const STATUS_COMMAND = { start: 'doing', wait: 'waiting', done: 'done', reopen: 'todo' };
const VERB = { created: 'Added', started: 'Started', waiting: 'Waiting on', done: 'Finished', reopened: 'Reopened', logged: '' };
const DAY = 86_400_000;
const PR_LABEL = { review: 'Review requested from you', merge: 'Ready to merge', changes: 'Changes requested', open: 'Awaiting review' };

let opts, positionals;
try {
  ({ values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: 'boolean' },
      archived: { type: 'boolean' },
      json: { type: 'boolean' },
      high: { type: 'boolean' },
      low: { type: 'boolean' },
      priority: { type: 'string' },
      due: { type: 'string' },
      note: { type: 'string' },
      link: { type: 'string' },
      status: { type: 'string' },
      title: { type: 'string' },
      project: { type: 'string' },
      color: { type: 'string' },
      days: { type: 'string' },
      ref: { type: 'string' },
      auto: { type: 'boolean' },
      'keep-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  console.error(`${err.message}\nRun \`track help\` for the options.`);
  process.exit(1);
}

const [command = 'ls', ...args] = positionals;
const source = opts.auto || process.env.TRACK_SOURCE === 'auto' ? 'auto' : 'manual';

function print(value) {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function localDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function taskLine(task) {
  const parts = [`#${String(task.id).padEnd(4)}`, STATUS_LABEL[task.status].padEnd(11)];
  parts.push(task.priority === 'high' ? 'HIGH ' : task.priority === 'low' ? 'low  ' : '     ');
  parts.push(task.title);
  const extra = [];
  if (task.due_date) extra.push(task.status !== 'done' && task.due_date < localDate(Date.now()) ? `OVERDUE ${task.due_date}` : `due ${task.due_date}`);
  if (task.status === 'done' && task.done_at) extra.push(`done ${localDate(task.done_at)}`);
  if (task.link) extra.push(task.link);
  return `  ${parts.join(' ')}${extra.length ? `  (${extra.join(', ')})` : ''}`;
}

function prLine(pr) {
  const days = Math.floor((Date.now() - new Date(pr.opened_at)) / DAY);
  const extra = [pr.project_name ?? pr.repo.split('/')[0], days ? `opened ${days}d ago` : 'opened today'];
  if (pr.stale) extra.push(PR_LABEL[pr.group].toLowerCase());
  if (pr.group === 'review') extra.push(`by ${pr.author}`);
  if (pr.draft) extra.push('draft');
  if (pr.checks === 'failing') extra.push('CHECKS FAILING');
  if (pr.conflicts) extra.push('CONFLICTS');
  if ((pr.group === 'merge' || pr.group === 'open') && pr.approved_by.length) extra.push(`approved by ${pr.approved_by.join(', ')}`);
  if (pr.group === 'changes' && pr.changes_by.length) extra.push(`changes from ${pr.changes_by.join(', ')}`);
  if (pr.group === 'changes' && pr.commented_by.length) extra.push(`comments from ${pr.commented_by.join(', ')}`);
  if (pr.group === 'open' && !pr.draft) extra.push(pr.reviewers.length ? `waiting on ${pr.reviewers.join(', ')}` : 'no reviewer requested');
  const ref = `${pr.repo.split('/')[1]}#${pr.number}`;
  return `  ${ref.padEnd(22)} ${pr.title}  (${extra.join(' · ')})\n  ${' '.repeat(22)} ${pr.url}`;
}

function priorityFromOpts() {
  if (opts.high) return 'high';
  if (opts.low) return 'low';
  return opts.priority;
}

function dueFromOpts() {
  if (opts.due === undefined) return undefined;
  return ['none', 'clear', ''].includes(opts.due) ? null : opts.due;
}

function requireArgs(count, usage) {
  if (args.length < count) throw new store.InputError(`Usage: track ${usage}`);
}

function taskIds() {
  const ids = args.map(Number);
  if (!ids.length || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new store.InputError(`Usage: track ${command} <task id...>`);
  }
  return ids;
}

const commands = {
  async ls() {
    const project = args[0] ? await store.findProject(args[0]) : null;
    const tasks = await store.listTasks({
      projectId: project?.id,
      includeArchived: Boolean(project),
      doneSince: opts.all ? new Date(Date.now() - 14 * DAY) : null,
    });
    if (opts.json) return print(tasks);
    if (!tasks.length) return print(project ? `No open tasks in ${project.name}.` : 'No open tasks.');
    const byProject = Map.groupBy(tasks, (t) => t.project_name);
    print([...byProject].map(([name, list]) => `${name}\n${list.map(taskLine).join('\n')}`).join('\n\n'));
  },

  async add() {
    requireArgs(2, 'add <project> <title...>');
    const project = await store.findProject(args[0]);
    const tracked = opts.link && (await store.findTaskByLink(opts.link));
    if (tracked) return print(opts.json ? { ...tracked, existing: true } : `Already tracked as #${tracked.id}: ${tracked.title}`);
    const task = await store.createTask({
      project_id: project.id,
      title: args.slice(1).join(' '),
      priority: priorityFromOpts(),
      due_date: dueFromOpts(),
      notes: opts.note,
      link: opts.link,
      status: opts.status,
    }, { source });
    if (opts.json) return print(task);
    print(`Added #${task.id} to ${project.name}: ${task.title}${task.restored_project ? ` (${project.name} was archived, so it's active again)` : ''}`);
  },

  async edit() {
    requireArgs(1, 'edit <id> [--title ..] [--due ..] [--priority ..] [--note ..] [--link ..] [--project ..]');
    const [taskId] = taskIds();
    const patch = {
      title: opts.title,
      due_date: dueFromOpts(),
      priority: priorityFromOpts(),
      notes: opts.note,
      link: opts.link,
      status: opts.status,
    };
    if (opts.project) patch.project_id = (await store.findProject(opts.project)).id;
    const task = await store.updateTask(taskId, patch, { source });
    print(opts.json ? task : `Updated #${task.id}: ${task.title}`);
  },

  async show() {
    requireArgs(1, 'show <id>');
    const task = await store.getTask(taskIds()[0]);
    if (opts.json) return print(task);
    print(`${task.project_name}\n${taskLine(task)}${task.notes ? `\n\n${task.notes}` : ''}`);
  },

  async rm() {
    for (const taskId of taskIds()) {
      const { ignored_link: ignored } = await store.deleteTask(taskId);
      print(`Deleted #${taskId}${ignored ? ' (the auto-update won\'t add its ticket back)' : ''}`);
    }
  },

  async log() {
    requireArgs(2, 'log <project> <text...>');
    const project = await store.findProject(args[0]);
    const entry = await store.logAction({ project_id: project.id, text: args.slice(1).join(' '), ref: opts.ref }, { source });
    if (opts.json) return print(entry);
    const verb = { added: 'Logged', updated: 'Updated', unchanged: 'Already logged' }[entry.result];
    print(`${verb} for ${project.name}: ${entry.text}`);
  },

  async recent() {
    const days = Number(opts.days ?? 1);
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (days - 1));
    const project = args[0] ? await store.findProject(args[0]) : null;
    const activity = await store.listActivity({ since, projectId: project?.id });
    if (opts.json) return print(activity);
    if (!activity.length) return print('Nothing recorded yet.');
    const byDay = Map.groupBy(activity, (a) => localDate(a.at));
    print([...byDay].map(([day, items]) => `${day}\n${items.map((a) => {
      const time = new Date(a.at).toTimeString().slice(0, 5);
      return `  ${time}  ${a.project_name.padEnd(16)} ${VERB[a.kind] ? `${VERB[a.kind]} ` : ''}${a.text}`;
    }).join('\n')}`).join('\n\n'));
  },

  async projects() {
    const archived = opts.all ? undefined : Boolean(opts.archived);
    const projects = await store.listProjects({ archived });
    if (opts.json) return print(projects);
    if (!projects.length) return print(archived ? 'No archived projects.' : 'No projects yet. Add one with: track project add "Name"');
    print(projects.map((p) => {
      const pct = p.total_count ? Math.round((p.done_count / p.total_count) * 100) : 0;
      const last = p.last_activity_at ? `last activity ${localDate(p.last_activity_at)}` : 'no activity yet';
      const tag = p.archived_at ? `  [archived ${localDate(p.archived_at)}]` : '';
      const tickets = [p.jira_site && `Jira ${p.jira_site}`, p.linear_team && `Linear ${p.linear_team}`].filter(Boolean);
      return `${String(p.id).padStart(3)}  ${p.name.padEnd(20)} ${String(p.open_count).padStart(3)} open  ${String(pct).padStart(3)}% done  ${last}${tag}${tickets.length ? `  (tickets: ${tickets.join(', ')})` : ''}`;
    }).join('\n'));
  },

  async project() {
    const [action, ref, ...rest] = args;
    if (action === 'add') {
      const project = await store.createProject({ name: [ref, ...rest].join(' '), color: opts.color });
      return print(opts.json ? project : `Added project ${project.name} (${project.color})`);
    }
    if (action === 'rename' && ref && rest.length) {
      const project = await store.findProject(ref);
      const updated = await store.updateProject(project.id, { name: rest.join(' ') });
      return print(`Renamed ${project.name} to ${updated.name}`);
    }
    if (action === 'color' && ref && rest.length) {
      const project = await store.findProject(ref);
      await store.updateProject(project.id, { color: rest[0] });
      return print(`${project.name} is now ${rest[0]}`);
    }
    if ((action === 'jira' || action === 'linear') && ref && rest.length) {
      const project = await store.findProject(ref);
      const field = action === 'jira' ? 'jira_site' : 'linear_team';
      const updated = await store.updateProject(project.id, { [field]: rest.join(' ') });
      const label = action === 'jira' ? 'Jira site' : 'Linear team';
      return print(updated[field] ? `${project.name}: ${label} is ${updated[field]}` : `${project.name}: no ${label}`);
    }
    throw new store.InputError('Usage: track project add <name> | rename <project> <new name> | color <project> <color> | jira <project> <site|none> | linear <project> <team|none>');
  },

  async archive() {
    requireArgs(1, 'archive <project>');
    const project = await store.findProject(args.join(' '));
    await store.updateProject(project.id, { archived: true });
    print(`Archived ${project.name}. Its tasks are kept; bring it back with: track unarchive "${project.name}"`);
  },

  async unarchive() {
    requireArgs(1, 'unarchive <project>');
    const project = await store.findProject(args.join(' '));
    await store.updateProject(project.id, { archived: false });
    print(`${project.name} is active again`);
  },

  async state() {
    print(await store.getState());
  },

  async tickets() {
    requireArgs(1, "tickets '<json array of {project, link, title, status, state}>'");
    let tickets;
    try {
      tickets = JSON.parse(args.join(' '));
    } catch {
      throw new store.InputError('tickets takes one JSON array, e.g. \'[{"project":"acme-co","link":"https://...","title":"...","status":"In Progress","state":"indeterminate"}]\'');
    }
    if (!Array.isArray(tickets)) throw new store.InputError('tickets takes a JSON array');
    const counts = {};
    const lines = [];
    for (const ticket of tickets) {
      try {
        const result = await store.syncTicket(ticket, { allowDone: !opts['keep-open'] });
        counts[result.action] = (counts[result.action] ?? 0) + 1;
        if (result.action === 'added') lines.push(`added #${result.task.id} ${result.task.title} (${result.task.status})`);
        if (result.action === 'moved') lines.push(`moved #${result.task.id} ${result.task.title}: ${result.from} -> ${result.task.status}`);
      } catch (err) {
        counts.failed = (counts.failed ?? 0) + 1;
        lines.push(`failed ${ticket?.link ?? JSON.stringify(ticket)}: ${err.message}`);
      }
    }
    const summary = Object.entries(counts).map(([action, n]) => `${n} ${action}`).join(', ') || 'no tickets';
    print(opts.json ? { counts, lines } : [...lines, `Tickets: ${summary}`].join('\n'));
  },

  async notes() {
    const project = args[0] ? await store.findProject(args.join(' ')) : null;
    const notes = await store.listNotes({ projectId: project?.id, includeArchived: Boolean(project) });
    if (opts.json) return print(notes);
    if (!notes.length) return print(project ? `No notes for ${project.name}.` : 'No notes yet. Write one with: track note add common "..."');
    print(notes.map((n) => {
      const head = `#${n.id}  ${n.project_name}  ${localDate(n.updated_at)}${n.pinned ? '  [pinned]' : ''}`;
      return `${head}\n${n.body.replace(/^/gm, '  ')}`;
    }).join('\n\n'));
  },

  async note() {
    const [action, ref, ...rest] = args;
    const noteId = () => {
      const value = Number(ref);
      if (!Number.isInteger(value) || value <= 0) throw new store.InputError(`Usage: track note ${action} <note id>`);
      return value;
    };
    if (action === 'add' && ref && rest.length) {
      const project = await store.findProject(ref);
      const note = await store.createNote({ project_id: project.id, body: rest.join(' ') });
      return print(opts.json ? note : `Saved note #${note.id} for ${project.name}`);
    }
    if (action === 'edit' && rest.length) {
      const note = await store.updateNote(noteId(), { body: rest.join(' ') });
      return print(opts.json ? note : `Updated note #${note.id}`);
    }
    if (action === 'pin' || action === 'unpin') {
      const note = await store.updateNote(noteId(), { pinned: action === 'pin' });
      return print(`${action === 'pin' ? 'Pinned' : 'Unpinned'} note #${note.id}`);
    }
    if (action === 'rm') {
      await store.deleteNote(noteId());
      return print(`Deleted note #${ref}`);
    }
    throw new store.InputError('Usage: track note add <project> <text...> | edit <id> <text...> | pin <id> | unpin <id> | rm <id>');
  },

  async prs() {
    const data = await getPullRequests({ refresh: true });
    if (data.error && !data.prs.length) throw new store.InputError(data.error);
    if (opts.json) return print(data);
    const groups = PR_GROUPS.map((group) => {
      const prs = data.prs.filter((pr) => pr.group === group && !pr.stale);
      return `${PR_LABEL[group]} (${prs.length})${prs.map((pr) => `\n${prLine(pr)}`).join('')}`;
    });
    const stale = data.prs.filter((pr) => pr.stale);
    if (stale.length) {
      groups.push(`Untouched for ${STALE_DAYS}+ days (${stale.length})${stale.map((pr) => `\n${prLine(pr)}`).join('')}`);
    }
    print(groups.join('\n\n'));
  },

  async runs() {
    const runs = await store.listAutoRuns({ limit: 10 });
    if (opts.json) return print(runs);
    if (!runs.length) return print('The auto-update has not run yet.');
    print(runs.map((r) => {
      const when = `${localDate(r.started_at)} ${new Date(r.started_at).toTimeString().slice(0, 5)}`;
      const cost = r.cost_usd == null ? '' : `  $${r.cost_usd.toFixed(2)}`;
      return `${when}  ${r.ok ? 'ok    ' : 'FAILED'}${cost}  ${r.summary}`;
    }).join('\n'));
  },
};

for (const [name, status] of Object.entries(STATUS_COMMAND)) {
  commands[name] = async () => {
    for (const taskId of taskIds()) {
      const task = await store.updateTask(taskId, { status }, { source });
      print(`#${task.id} ${STATUS_LABEL[status]}: ${task.title}`);
    }
  };
}

try {
  if (opts.help || command === 'help') print(HELP);
  else if (!commands[command]) throw new store.InputError(`Unknown command "${command}". Run \`track help\`.`);
  else await commands[command]();
} catch (err) {
  const known = err instanceof store.InputError || err instanceof store.NotFoundError;
  console.error(known ? err.message : describeDbError(err) ?? err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
