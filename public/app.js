const COLORS = ['indigo', 'teal', 'amber', 'rose', 'violet', 'sky', 'lime', 'slate'];
const LANES = [
  { status: 'todo', label: 'To do' },
  { status: 'doing', label: 'In progress' },
  { status: 'waiting', label: 'Waiting', hint: 'on client or review' },
  { status: 'done', label: 'Done', hint: 'last 14 days' },
];
const LANE_EMPTY = {
  todo: 'Nothing to do here',
  doing: 'Drag a task here when you start it',
  waiting: 'Nothing waiting on anyone',
  done: 'Finished tasks land here',
};
// Pull request lanes, in the order the user has to act on them. Groups come from lib/github.js.
const PR_LANES = [
  { group: 'review', label: 'Review requested', hint: 'from you', empty: 'Nothing waiting for your review' },
  { group: 'merge', label: 'Ready to merge', hint: 'approved', empty: 'Nothing approved yet' },
  { group: 'changes', label: 'Changes requested', hint: 'or comments', empty: 'No changes or comments to answer' },
  { group: 'open', label: 'Awaiting review', hint: 'your other open PRs', empty: 'No other open PRs' },
];
// Claude review verdicts, as the /code-review skill words them.
const VERDICTS = [
  { label: 'Looks good', tone: 'good' },
  { label: 'A couple of things first', tone: 'warn' },
  { label: "Wouldn't merge yet", tone: 'bad' },
];
// The review dialog's buttons, by data-post. The first three are GitHub's review events.
const REVIEW_EVENTS = {
  comment: { label: 'Comment', confirm: 'Post comment?', done: 'Posted your comment on' },
  approve: { label: 'Approve', confirm: 'Approve on GitHub?', done: 'Approved' },
  request_changes: { label: 'Request changes', confirm: 'Request changes?', done: 'Requested changes on' },
  // Shown instead of Approve when Claude's verdict is "Looks good". Both post an approval.
  approve_comment: { event: 'approve', needsText: true, label: 'Approve with comment', confirm: 'Approve with this comment?', done: 'Approved' },
  approve_only: { event: 'approve', bare: true, label: 'Just approve', confirm: 'Approve without a comment?', done: 'Approved' },
};
// Merge buttons, by the repo's default merge method.
const MERGE_LABELS = { merge: 'Merge', squash: 'Squash and merge', rebase: 'Rebase and merge' };
const VERB = { created: 'Added', started: 'Started', waiting: 'Waiting on', done: 'Finished', reopened: 'Reopened', logged: '' };

const DAY = 86_400_000;
const QUIET_AFTER_DAYS = 30;
const DONE_LANE_DAYS = 14;
const CHART_DAYS = 14;
const FEED_DAYS = 7;
const NOTES_PAGE = 10;
const REFRESH_MS = 15_000;
const GITHUB_REFRESH_MS = 60_000;
const REVIEW_POLL_MS = 10_000;
const PR_LANE_LIMIT = 4;
const ARM_MS = 4_000;

const state = {
  projects: [],
  tasks: [],
  activity: [],
  autoRun: null,
  filter: null,
  loaded: false,
  dragging: false,
  armed: null,
  dailyStatuses: [],
  feedLimit: FEED_DAYS,
  // Days whose tracker entries are unfolded under their daily status.
  openDays: new Set(),
  notes: [],
  notesLimit: NOTES_PAGE,
  openNotes: new Set(),
  editingNoteId: null,
  github: null,
  showStalePrs: false,
  openPrLanes: new Set(),
  merging: new Set(),
};

const $ = (id) => document.getElementById(id);

const storage = {
  get(key) {
    try {
      return localStorage.getItem(`workbench.${key}`);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(`workbench.${key}`);
      else localStorage.setItem(`workbench.${key}`, String(value));
    } catch {
      // Storage can be blocked; these are conveniences only.
    }
  },
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const color = (name) => (COLORS.includes(name) ? name : 'slate');
const swatch = (name) => `--pc: var(--p-${color(name)})`;

function truncate(text, max = 48) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Dates. Due dates are plain 'YYYY-MM-DD' strings in local time; timestamps are ISO strings.

function localISO(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseLocalDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek() {
  const d = startOfDay();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / DAY + 1) / 7);
}

// Whole calendar days from `date` to today; Math.round absorbs DST-shortened days.
const daysAgo = (date) => Math.round((startOfDay() - startOfDay(date)) / DAY);

const fmtDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const fmtDayYear = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const shortDate = (date) => (date.getFullYear() === new Date().getFullYear() ? fmtDay : fmtDayYear).format(date);
const fmtWeekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtLong = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

function relativeDay(date) {
  const n = daysAgo(date);
  if (n === 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n === -1) return 'tomorrow';
  return n > 1 && n < 7 ? fmtWeekday.format(date) : shortDate(date);
}

function dayHeading(date) {
  const label = relativeDay(date);
  return label === 'today' || label === 'yesterday' ? label[0].toUpperCase() + label.slice(1) : fmtWeekday.format(date);
}

// Data

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the tracker server. Is `npm start` still running?");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `The server answered ${res.status}`);
  return data;
}

async function load() {
  try {
    const data = await api('GET', '/api/state');
    state.projects = data.projects;
    state.tasks = data.tasks;
    state.activity = data.activity;
    state.notes = data.notes;
    state.autoRun = data.autoRun;
    state.dailyStatuses = data.dailyStatuses;
    state.loaded = true;
    if (state.filter && !activeProjects().some((p) => p.id === state.filter)) setFilter(null, false);
    $('banner').hidden = true;
    setSync(`Updated ${fmtTime.format(new Date())}`);
    render();
  } catch (err) {
    setSync('Not connected', true);
    $('banner').innerHTML = `${esc(err.message).replace(/`([^`]+)`/g, '<code>$1</code>')} The page retries every 15 seconds.`;
    $('banner').hidden = false;
  }
}

async function loadGithub(refresh = false) {
  try {
    state.github = await api('GET', `/api/github${refresh ? '?refresh=1' : ''}`);
  } catch (err) {
    state.github = { prs: [], fetched_at: null, ...state.github, error: err.message };
  }
  renderPulls();
  watchReviews();
}

// Everything on the page, with GitHub asked again rather than its one-minute cache. Starts no reviews.
async function refreshAll() {
  const button = $('refresh-all');
  button.disabled = true;
  try {
    await Promise.all([load(), loadGithub(true)]);
  } finally {
    button.disabled = false;
  }
}

async function runReviews() {
  const button = $('run-reviews');
  button.disabled = true;
  button.textContent = 'Checking GitHub…';
  try {
    const { queued, reviewing } = await api('POST', '/api/reviews/run', {});
    if (queued) toast(`Claude is reviewing ${queued} PR${queued === 1 ? '' : 's'}. Each takes a few minutes.`);
    else if (reviewing) toast('Claude is already on it. Nothing new to add.');
    else toast('Nothing new to review');
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Run reviews';
  }
  await loadGithub();
}

const fmtWeekdayShort = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });

function nextReviewsText(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  return `Reviews next run ${daysAgo(at) === 0 ? '' : `${fmtWeekdayShort.format(at)} `}${fmtTime.format(at)}`;
}

let reviewPoll;

// While Claude is reviewing, check more often than once a minute, so the review shows up soon after
// it's ready. The server reads reviews from the database, so this doesn't reach GitHub any more often.
function watchReviews() {
  clearTimeout(reviewPoll);
  const busy = state.github?.prs.some((pr) => ['queued', 'running'].includes(pr.review?.status));
  if (busy) {
    reviewPoll = setTimeout(() => {
      if (document.visibilityState === 'visible') loadGithub();
    }, REVIEW_POLL_MS);
  }
}

function setSync(text, isError = false) {
  const el = $('sync');
  el.textContent = text;
  el.classList.toggle('is-error', isError);
}

const activeProjects = () => state.projects.filter((p) => !p.archived_at);
const archivedProjects = () => state.projects.filter((p) => p.archived_at);
const projectById = (id) => state.projects.find((p) => p.id === id);
const taskById = (id) => state.tasks.find((t) => t.id === id);
const visibleTasks = () => (state.filter ? state.tasks.filter((t) => t.project_id === state.filter) : state.tasks);
const visibleActivity = () => (state.filter ? state.activity.filter((a) => a.project_id === state.filter) : state.activity);

function setFilter(id, rerender = true) {
  state.filter = id;
  storage.set('filter', id);
  if (rerender) render();
}

// Two-step delete buttons: the first click arms, a second click within a few seconds confirms.
const isArmed = (key) => state.armed?.key === key && state.armed.until > Date.now();

function arm(key) {
  state.armed = { key, until: Date.now() + ARM_MS };
  render();
  document.querySelector(`[data-arm="${key}"]`)?.focus();
  setTimeout(() => {
    if (state.armed?.key === key && state.armed.until <= Date.now()) {
      state.armed = null;
      render();
    }
  }, ARM_MS + 50);
}

// Rendering

function render() {
  if (!state.loaded) return;
  renderToday();
  renderAutoRun();
  renderSummary();
  renderProjects();
  renderFilter();
  renderPulls();
  renderBoard();
  renderNoteForm();
  renderNotes();
  renderChart();
  renderLogForm();
  renderFeed();
  renderArchive();
}

function renderToday() {
  const now = new Date();
  $('today').textContent = `${fmtLong.format(now)} · Week ${isoWeek(now)}`;
}

function renderAutoRun() {
  const run = state.autoRun;
  const el = $('auto-run');
  el.hidden = !run;
  if (!run) return;
  const when = new Date(run.started_at);
  const time = daysAgo(when) === 0 ? fmtTime.format(when) : `${relativeDay(when)} ${fmtTime.format(when)}`;
  el.textContent = run.ok ? `Auto-updated ${time}` : `Auto-update failed ${time}`;
  el.classList.toggle('is-error', !run.ok);
  const cost = run.cost_usd == null ? '' : ` ($${run.cost_usd.toFixed(2)})`;
  el.title = `${run.summary || 'No summary'}${cost}`;
}

function renderSummary() {
  const tasks = visibleTasks();
  const today = localISO();
  const weekStart = startOfWeek();
  const open = tasks.filter((t) => t.status !== 'done');
  const overdue = open.filter((t) => t.due_date && t.due_date < today).length;
  const stats = [
    { label: 'Open', value: open.length },
    { label: 'In progress', value: open.filter((t) => t.status === 'doing').length, tone: 'doing' },
    { label: 'Waiting', value: open.filter((t) => t.status === 'waiting').length, tone: 'waiting' },
    { label: 'Overdue', value: overdue, tone: overdue ? 'danger' : '' },
    {
      label: 'Done this week',
      value: tasks.filter((t) => t.status === 'done' && new Date(t.done_at) >= weekStart).length,
      tone: 'done',
    },
  ];
  $('summary').innerHTML = stats
    .map((s) => `<div class="stat" data-tone="${s.tone ?? ''}"><span class="stat-value">${s.value}</span><span class="stat-label">${s.label}</span></div>`)
    .join('');
}

function ring(p) {
  const r = 19;
  const circumference = 2 * Math.PI * r;
  const share = p.total_count ? p.done_count / p.total_count : 0;
  const label = p.total_count ? `${Math.round(share * 100)}%` : '–';
  const arc = share > 0
    ? `<circle class="value" cx="24" cy="24" r="${r}" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${(circumference * (1 - share)).toFixed(2)}" />`
    : '';
  return `<svg class="ring" viewBox="0 0 48 48" role="img" aria-label="${p.done_count} of ${p.total_count} tasks done">
    <circle class="track" cx="24" cy="24" r="${r}" />${arc}
    <text x="24" y="24.5" text-anchor="middle" dominant-baseline="central">${label}</text>
  </svg>`;
}

function lastActivityText(p) {
  const idle = daysAgo(new Date(p.last_activity_at ?? p.created_at));
  // Common can't be archived, so it never gets the nudge.
  if (idle >= QUIET_AFTER_DAYS && !p.is_common) return { text: `Quiet for ${idle} days`, quiet: true };
  if (!p.last_activity_at) return { text: 'No activity yet', quiet: false };
  if (idle === 0) return { text: 'Active today', quiet: false };
  if (idle === 1) return { text: 'Active yesterday', quiet: false };
  return { text: `Active ${idle} days ago`, quiet: false };
}

function projectCard(p) {
  const selected = state.filter === p.id;
  const last = lastActivityText(p);
  const sub = p.total_count
    ? `${p.open_count} open${p.waiting_count ? ` · <span class="waiting">${p.waiting_count} waiting</span>` : ''} · ${p.done_count} of ${p.total_count} done`
    : 'No tasks yet';
  return `<article class="project${selected ? ' is-selected' : ''}" style="${swatch(p.color)}">
    <button class="project-main" type="button" data-action="filter" data-id="${p.id}" aria-pressed="${selected}" title="${selected ? 'Show all projects' : `Show only ${esc(p.name)}`}">
      ${ring(p)}
      <span class="project-text">
        <span class="project-name">${esc(p.name)}</span>
        <span class="project-sub">${sub}</span>
      </span>
    </button>
    <div class="project-foot">
      <span class="${last.quiet ? 'is-quiet' : ''}">${last.text}</span>
      <span class="project-actions">
        <button class="btn ghost" type="button" data-action="edit-project" data-id="${p.id}">Edit</button>
        ${p.is_common ? '' : `<button class="btn ghost${last.quiet ? ' suggest' : ''}" type="button" data-action="archive" data-id="${p.id}"${last.quiet ? ` title="Not used for a while. Archive it to clear it off the board."` : ''}>Archive</button>`}
      </span>
    </div>
  </article>`;
}

function renderProjects() {
  const projects = activeProjects();
  $('projects').innerHTML = projects.length
    ? projects.map(projectCard).join('')
    : `<div class="project-empty">
        <p>Add a project for each client you work with. Tasks and the log are grouped by project.</p>
        <button class="btn primary small" type="button" data-action="new-project">Add your first project</button>
      </div>`;
}

function renderFilter() {
  const p = state.filter && projectById(state.filter);
  $('filter').innerHTML = p
    ? `<span class="chip" style="${swatch(p.color)}">${esc(p.name)} <button type="button" data-action="clear-filter" aria-label="Show all projects">×</button></span>`
    : 'All projects';
}

function linkLabel(href) {
  try {
    const url = new URL(href);
    const jira = url.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i) ?? [null, url.searchParams.get('selectedIssue')];
    if (jira[1]) return jira[1].toUpperCase();
    const github = url.hostname === 'github.com' && url.pathname.match(/^\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/);
    if (github) return `${github[1]}#${github[2]}`;
    const linear = url.hostname.endsWith('linear.app') && url.pathname.match(/\/issue\/([A-Z]+-\d+)/i);
    if (linear) return linear[1].toUpperCase();
    return url.hostname.replace(/^www\./, '');
  } catch {
    return 'Link';
  }
}

const safeLink = (link) => (/^https?:\/\//i.test(link ?? '') ? link : null);

function dueTag(task, today) {
  if (!task.due_date) return '';
  const due = parseLocalDate(task.due_date);
  if (task.due_date < today) return `<span class="tag overdue">Overdue · ${shortDate(due)}</span>`;
  const soon = daysAgo(due) >= -2;
  return `<span class="tag${soon ? ' soon' : ''}">Due ${relativeDay(due)}</span>`;
}

function taskCard(task, today) {
  const done = task.status === 'done';
  const meta = [];
  if (!state.filter) meta.push(`<span class="chip" style="${swatch(task.project_color)}">${esc(task.project_name)}</span>`);
  if (task.priority === 'high' && !done) meta.push('<span class="tag high">High</span>');
  if (done) meta.push(`<span class="tag">Done ${relativeDay(new Date(task.done_at))}</span>`);
  else meta.push(dueTag(task, today));
  const href = safeLink(task.link);
  if (href) {
    meta.push(`<a class="tag link" href="${esc(href)}" target="_blank" rel="noopener noreferrer" draggable="false">${esc(linkLabel(href))}</a>`);
  }
  if (task.external_status && !done) meta.push(`<span class="tag" title="Status of the linked ticket">${esc(task.external_status)}</span>`);
  if (task.notes) meta.push('<span class="tag" title="Has notes">Notes</span>');
  const metaHtml = meta.filter(Boolean).join('');
  return `<article class="task${done ? ' is-done' : ''}" draggable="true" data-id="${task.id}">
    <button class="check" type="button" data-action="toggle-done" data-id="${task.id}" aria-label="${done ? 'Move back to To do' : 'Mark done'}: ${esc(task.title)}">
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.5 9.5 3.5" /></svg>
    </button>
    <div class="task-body">
      <button class="task-title" type="button" data-action="edit-task" data-id="${task.id}">${esc(task.title)}</button>
      ${metaHtml ? `<div class="task-meta">${metaHtml}</div>` : ''}
    </div>
  </article>`;
}

function renderBoard() {
  const today = localISO();
  const doneSince = Date.now() - DONE_LANE_DAYS * DAY;
  const tasks = visibleTasks();
  const noTasksAtAll = !state.tasks.length;
  $('board').innerHTML = LANES.map((lane) => {
    let items = tasks.filter((t) => t.status === lane.status);
    if (lane.status === 'done') {
      items = items
        .filter((t) => new Date(t.done_at) >= doneSince)
        .sort((a, b) => new Date(b.done_at) - new Date(a.done_at));
    }
    const empty = lane.status === 'todo' && noTasksAtAll
      ? (activeProjects().length ? 'No tasks yet. Press N to add one.' : 'Add a project, then your first task.')
      : LANE_EMPTY[lane.status];
    return `<section class="lane" data-status="${lane.status}" aria-label="${lane.label}">
      <header class="lane-head">
        <h3>${lane.label}</h3>
        <span class="lane-count">${items.length}</span>
        ${lane.hint ? `<span class="lane-hint">${lane.hint}</span>` : ''}
      </header>
      ${items.length ? items.map((t) => taskCard(t, today)).join('') : `<p class="lane-empty">${empty}</p>`}
    </section>`;
  }).join('');
}

function ageText(days) {
  if (days < 1) return 'today';
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  if (days < 730) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function prCard(pr) {
  const [owner, repo] = pr.repo.split('/');
  const meta = [];
  if (!pr.project_id) meta.push(`<span class="chip">${esc(owner)}</span>`);
  else if (state.filter !== pr.project_id) meta.push(`<span class="chip" style="${swatch(pr.project_color)}">${esc(pr.project_name)}</span>`);
  meta.push(`<span class="tag pr-ref">${esc(repo)}#${pr.number}</span>`);
  const opened = new Date(pr.opened_at);
  const updated = new Date(pr.updated_at);
  meta.push(`<span class="tag" title="Opened ${shortDate(opened)}, last updated ${shortDate(updated)}">Opened ${ageText(daysAgo(opened))}</span>`);
  if (pr.draft) meta.push('<span class="tag">Draft</span>');
  if (pr.checks === 'failing') meta.push('<span class="tag bad">Checks failing</span>');
  else if (pr.checks === 'running') meta.push('<span class="tag">Checks running</span>');
  if (pr.conflicts) meta.push('<span class="tag bad">Conflicts</span>');
  if (pr.group === 'review') meta.push(`<span class="tag">by ${esc(pr.author)}</span>`);
  if ((pr.group === 'merge' || pr.group === 'open') && pr.approved_by.length) meta.push(`<span class="tag good">Approved by ${esc(pr.approved_by.join(', '))}</span>`);
  if (pr.group === 'changes' && pr.changes_by.length) meta.push(`<span class="tag warn">Changes from ${esc(pr.changes_by.join(', '))}</span>`);
  if (pr.group === 'changes' && pr.commented_by?.length) meta.push(`<span class="tag">Comments from ${esc(pr.commented_by.join(', '))}</span>`);
  if (pr.group === 'open' && !pr.draft) {
    meta.push(pr.reviewers.length
      ? `<span class="tag">Waiting on ${esc(pr.reviewers.join(', '))}</span>`
      : '<span class="tag warn" title="Nobody has been asked to review it">No reviewer</span>');
  }
  if (pr.stale) meta.push(`<span class="tag" title="Last updated ${shortDate(updated)}">Untouched ${ageText(daysAgo(updated)).replace(' ago', '')}</span>`);
  const href = safeLink(pr.url) ?? '#';
  const action = pr.group === 'review' ? reviewChip(pr) : pr.group === 'merge' ? mergeChip(pr) : '';
  return `<article class="pr${pr.stale ? ' is-stale' : ''}">
    <a class="pr-title" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(pr.title)}</a>
    <div class="task-meta">${meta.join('')}</div>
    ${action ? `<div class="pr-action">${action}</div>` : ''}
  </article>`;
}

// The skill writes what the change does, then a verdict line, then the findings. Only the verdict
// and findings are meant for GitHub: the author knows what their change does.
function splitReview(body) {
  const paragraphs = body.trim().split(/\n\s*\n/);
  for (const [index, paragraph] of paragraphs.entries()) {
    const start = paragraph.replace(/^[*_\s]+/, '').replace(/\u2019/g, "'").toLowerCase();
    const verdict = VERDICTS.find((v) => start.startsWith(v.label.toLowerCase()));
    if (verdict) {
      return { summary: paragraphs.slice(0, index).join('\n\n'), post: paragraphs.slice(index).join('\n\n'), verdict };
    }
  }
  return { summary: '', post: body.trim(), verdict: null };
}

// What the dialog shows and posts. The server splits each review into a draft: the summary and Claude's
// notes stay on the page, the body is the review's own text, and each comment goes on its line. An old
// review the server hasn't split yet posts as one text.
function reviewParts(review) {
  const { draft } = review;
  if (!draft) return { ...splitReview(review.body), notes: '', comments: [] };
  return {
    summary: draft.summary,
    notes: draft.notes,
    post: draft.body,
    comments: draft.comments,
    verdict: VERDICTS.find((v) => v.label === draft.verdict) ?? null,
  };
}

// Claude's review of a PR waiting for the user: queued, running, or a button that opens it.
function reviewChip(pr) {
  const { review } = pr;
  if (!review) {
    return `<button class="review-chip" type="button" data-action="request-review" data-url="${esc(pr.url)}">Review with Claude</button>`;
  }
  if (review.status === 'queued') return '<span class="review-chip is-busy">Claude review queued</span>';
  if (review.status === 'running') {
    const since = review.started_at ? ` title="Started at ${fmtTime.format(new Date(review.started_at))}"` : '';
    return `<span class="review-chip is-busy"${since}>Claude is reviewing…</span>`;
  }
  if (review.status === 'failed') {
    return `<button class="review-chip bad" type="button" data-action="open-review" data-id="${review.id}">Claude review failed</button>`;
  }
  const { verdict } = reviewParts(review);
  const tone = review.dismissed ? 'is-dismissed' : verdict?.tone ?? '';
  const label = `Claude: ${verdict?.label ?? 'review ready'}${review.outdated ? ' · new commits since' : ''}`;
  return `<button class="review-chip ${tone}" type="button" data-action="open-review" data-id="${review.id}">${esc(label)}</button>`;
}

// Merging an approved PR of the user's. The first click asks, naming the method and the base branch.
// A PR GitHub won't merge yet says why instead; conflicts already have their own tag.
function mergeChip(pr) {
  if (state.merging.has(pr.url)) return '<span class="review-chip is-busy">Merging…</span>';
  if (pr.conflicts || !pr.merge_method) return '';
  if (pr.merge_blocker) {
    return `<span class="review-chip is-busy" title="GitHub won't merge it until this is sorted on GitHub">${esc(pr.merge_blocker)}</span>`;
  }
  const key = `merge:${pr.url}`;
  const armed = isArmed(key);
  const label = MERGE_LABELS[pr.merge_method];
  const confirm = `${label} into ${pr.base_ref}${pr.checks === 'failing' ? ' with failing checks' : ''}?`;
  return `<button class="review-chip merge${armed ? ' is-armed' : ''}" type="button" data-action="merge-pr" data-url="${esc(pr.url)}" data-arm="${esc(key)}">${esc(armed ? confirm : label)}</button>`;
}

async function mergePr(url) {
  const pr = state.github?.prs.find((p) => p.url === url);
  if (!pr) return;
  state.armed = null;
  state.merging.add(url);
  renderPulls();
  try {
    await api('POST', '/api/github/merge', { url, head_sha: pr.head_sha });
    toast(`Merged ${pr.repo.split('/')[1]}#${pr.number} into ${pr.base_ref}`);
  } catch (err) {
    toast(err.message);
  }
  state.merging.delete(url);
  await loadGithub();
}

// PRs untouched for a long time (stale) stay folded away unless the user asks for them.
function renderPulls() {
  const data = state.github;
  const lanes = $('prs');
  const errorEl = $('prs-error');
  const toggle = $('prs-stale');
  if (!data) {
    $('prs-status').textContent = 'Checking GitHub…';
    return;
  }
  const checkedAt = data.fetched_at ? fmtTime.format(new Date(data.fetched_at)) : null;
  $('prs-status').textContent = [checkedAt && `Checked ${checkedAt}`, nextReviewsText(data.reviews_next_at)].filter(Boolean).join(' · ');
  errorEl.hidden = !data.error;
  if (data.error) {
    errorEl.innerHTML = `${esc(data.error).replace(/`([^`]+)`/g, '<code>$1</code>')}${checkedAt ? ` Showing the list from ${checkedAt}.` : ''}`;
  }
  // Empty lanes would claim there's nothing to review, so show none until GitHub has answered once.
  lanes.hidden = !data.fetched_at;
  const visible = data.prs.filter((pr) => !state.filter || pr.project_id === state.filter);
  const fresh = visible.filter((pr) => !pr.stale);
  const stale = visible.filter((pr) => pr.stale);
  const shown = state.showStalePrs ? [...fresh, ...stale] : fresh;
  lanes.innerHTML = PR_LANES.map((lane) => {
    const items = shown.filter((pr) => pr.group === lane.group);
    // Long lanes show their first few PRs, so one busy lane doesn't push the board down the page.
    const open = state.openPrLanes.has(lane.group);
    const listed = open ? items : items.slice(0, PR_LANE_LIMIT);
    const more = items.length > PR_LANE_LIMIT
      ? `<button class="lane-more" type="button" data-action="toggle-pr-lane" data-group="${lane.group}" aria-expanded="${open}">${open ? 'Show fewer' : `Show ${items.length - listed.length} more`}</button>`
      : '';
    return `<section class="lane" data-group="${lane.group}" aria-label="${lane.label}">
      <header class="lane-head">
        <h3>${lane.label}</h3>
        <span class="lane-count">${items.length}</span>
        <span class="lane-hint">${lane.hint}</span>
      </header>
      ${items.length ? listed.map(prCard).join('') : `<p class="lane-empty">${lane.empty}</p>`}
      ${more}
    </section>`;
  }).join('');
  toggle.hidden = !stale.length || !data.fetched_at;
  const count = `${stale.length} older PR${stale.length === 1 ? '' : 's'}`;
  toggle.textContent = state.showStalePrs
    ? `Hide ${count}`
    : `Show ${count}, untouched for ${data.stale_days}+ days`;
  toggle.setAttribute('aria-expanded', String(state.showStalePrs));
}

function niceMax(value) {
  if (value <= 2) return 2;
  if (value <= 4) return 4;
  if (value <= 5) return 5;
  if (value <= 10) return 10;
  return Math.ceil(value / 5) * 5;
}

let chartWidth = 0;

function renderChart() {
  const figure = $('chart');
  chartWidth = figure.clientWidth;
  const start = startOfDay();
  start.setDate(start.getDate() - (CHART_DAYS - 1));
  const days = Array.from({ length: CHART_DAYS }, (_, i) => {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    return { date, key: localISO(date), done: 0, logged: 0 };
  });
  const byKey = new Map(days.map((d) => [d.key, d]));
  for (const entry of visibleActivity()) {
    if (entry.kind !== 'done' && entry.kind !== 'logged') continue;
    const day = byKey.get(localISO(new Date(entry.at)));
    if (day) day[entry.kind] += 1;
  }
  const doneTotal = days.reduce((sum, d) => sum + d.done, 0);
  const loggedTotal = days.reduce((sum, d) => sum + d.logged, 0);
  const top = niceMax(Math.max(...days.map((d) => d.done + d.logged)));

  // Drawn at the figure's real width so bars and labels keep their size at any layout width.
  const W = Math.max(240, chartWidth - 30);
  const H = 128;
  const pad = { left: 22, right: 2, top: 6, bottom: 20 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const slot = plotW / CHART_DAYS;
  const barW = Math.min(18, slot * 0.6);
  const y = (v) => pad.top + plotH - (v / top) * plotH;
  const ticks = top % 2 === 0 ? [0, top / 2, top] : [0, top];

  const grid = ticks
    .map((t) => `<line class="grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y(t)}" y2="${y(t)}" />
      <text class="axis-label" x="${pad.left - 6}" y="${y(t)}" text-anchor="end" dominant-baseline="central">${t}</text>`)
    .join('');
  const bars = days
    .map((d, i) => {
      const x = pad.left + i * slot + (slot - barW) / 2;
      const isToday = i === CHART_DAYS - 1;
      const label = `<text class="axis-label${isToday ? ' is-today' : ''}" x="${x + barW / 2}" y="${H - 6}" text-anchor="middle">${d.date.getDate()}</text>`;
      if (!d.done && !d.logged) {
        return `<rect class="bar-empty" x="${x}" y="${y(0) - 2}" width="${barW}" height="2" rx="1" />${label}`;
      }
      const doneTop = y(d.done);
      const loggedTop = y(d.done + d.logged);
      return `<g><title>${fmtWeekday.format(d.date)}: ${d.done} finished, ${d.logged} logged</title>
        ${d.done ? `<rect class="bar-done" x="${x}" y="${doneTop}" width="${barW}" height="${y(0) - doneTop}" rx="1.5" />` : ''}
        ${d.logged ? `<rect class="bar-logged" x="${x}" y="${loggedTop}" width="${barW}" height="${doneTop - loggedTop - (d.done ? 1 : 0)}" rx="1.5" />` : ''}
      </g>${label}`;
    })
    .join('');

  figure.innerHTML = `<figcaption class="chart-head">
      <span class="chart-title">Last 14 days</span>
      <span class="chart-total">${doneTotal} finished · ${loggedTotal} logged</span>
    </figcaption>
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Tasks finished and actions logged per day over the last 14 days: ${doneTotal} finished, ${loggedTotal} logged">${grid}${bars}</svg>
    <div class="legend">
      <span style="--swatch: var(--st-done)">Tasks finished</span>
      <span style="--swatch: var(--accent)">Actions logged</span>
    </div>`;
}

const projectSelects = new Map();

// Fills a project dropdown, rebuilding it only when the project list changed so a refresh doesn't
// reset an open dropdown. It follows the project filter when that changes, but leaves a manual pick
// alone on refresh. `storageKey` remembers the last project used with it.
function syncProjectSelect(select, storageKey) {
  const projects = activeProjects();
  const memo = projectSelects.get(select) ?? { key: '', filter: undefined };
  const key = projects.map((p) => `${p.id}:${p.name}`).join('|');
  if (key !== memo.key) {
    const current = Number(select.value) || Number(storage.get(storageKey));
    select.innerHTML = projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if (projects.some((p) => p.id === current)) select.value = String(current);
    memo.key = key;
  }
  if (state.filter !== memo.filter) {
    memo.filter = state.filter;
    if (state.filter && projects.some((p) => p.id === state.filter)) select.value = String(state.filter);
  }
  projectSelects.set(select, memo);
  return projects;
}

function renderLogForm() {
  const projects = syncProjectSelect($('log-project'), 'logProject');
  const select = $('log-project');
  const disabled = !projects.length;
  $('log-text').disabled = disabled;
  select.disabled = disabled;
  $('log-form').querySelector('button').disabled = disabled;
  $('log-text').placeholder = disabled ? 'Add a project first' : 'Log something you did, e.g. Call with client about payouts';
}

function renderNoteForm() {
  syncProjectSelect($('note-project'), 'noteProject');
}

// Escapes a note and turns its web addresses into links. Trailing punctuation stays outside the link.
function linkify(value) {
  return esc(value).replace(/https?:\/\/[^\s<]+/g, (match) => {
    const trail = match.match(/[.,!?)\]]+$/)?.[0] ?? '';
    const url = trail ? match.slice(0, -trail.length) : match;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
  });
}

function noteCard(note) {
  const armKey = `note:${note.id}`;
  const armed = isArmed(armKey);
  const open = state.openNotes.has(note.id);
  const written = new Date(note.created_at);
  const updated = new Date(note.updated_at);
  const when = daysAgo(updated) === 0 ? fmtTime.format(updated) : relativeDay(updated);
  const edited = updated - written > 60_000;
  const title = `Written ${shortDate(written)} ${fmtTime.format(written)}${edited ? `, edited ${shortDate(updated)} ${fmtTime.format(updated)}` : ''}`;
  return `<article class="note${note.pinned ? ' is-pinned' : ''}" data-id="${note.id}">
    <div class="note-body${open ? ' is-open' : ''}">${linkify(note.body)}</div>
    <button class="note-more" type="button" data-action="toggle-note" data-id="${note.id}" hidden>${open ? 'Show less' : 'Show more'}</button>
    <footer class="note-foot">
      ${note.pinned ? '<span class="note-pinned">Pinned</span>' : ''}
      ${state.filter ? '' : `<span class="chip" style="${swatch(note.project_color)}">${esc(note.project_name)}</span>`}
      <time datetime="${esc(note.updated_at)}" title="${title}">${edited ? 'Edited ' : ''}${when}</time>
      <span class="note-actions">
        <button class="note-action" type="button" data-action="pin-note" data-id="${note.id}" aria-pressed="${note.pinned}">${note.pinned ? 'Unpin' : 'Pin'}</button>
        <button class="note-action" type="button" data-action="edit-note" data-id="${note.id}">Edit</button>
        <button class="note-action danger${armed ? ' is-armed' : ''}" type="button" data-action="delete-note" data-id="${note.id}" data-arm="${armKey}" aria-label="${armed ? 'Click again to delete this note' : 'Delete this note'}">${armed ? 'Delete?' : 'Delete'}</button>
      </span>
    </footer>
  </article>`;
}

function renderNotes() {
  // Re-rendering would throw away an edit in progress; saving or cancelling renders again.
  if (state.editingNoteId) return;
  const notes = state.filter ? state.notes.filter((n) => n.project_id === state.filter) : state.notes;
  $('notes-count').textContent = notes.length || '';
  const listed = notes.slice(0, state.notesLimit);
  const more = notes.length - listed.length;
  $('notes').innerHTML = listed.length
    ? listed.map(noteCard).join('') + (more
      ? `<button class="btn ghost small feed-more" type="button" data-action="notes-more">Show ${Math.min(NOTES_PAGE, more)} more</button>`
      : '')
    : `<p class="feed-empty">${state.filter ? 'No notes for this project.' : 'Nothing written yet. Notes stay here until you delete them.'}</p>`;
  // Long notes are clamped. Offer "Show more" only where the text is actually cut off.
  for (const body of $('notes').querySelectorAll('.note-body')) {
    const toggle = body.nextElementSibling;
    toggle.hidden = !body.classList.contains('is-open') && body.scrollHeight <= body.clientHeight + 1;
  }
}

function autosize(area, max = 320) {
  area.style.height = 'auto';
  area.style.height = `${Math.min(area.scrollHeight + 2, max)}px`;
}

function startEditingNote(id) {
  const note = state.notes.find((n) => n.id === id);
  const card = document.querySelector(`.note[data-id="${id}"]`);
  if (!note || !card) return;
  state.editingNoteId = id;
  const options = activeProjects()
    .map((p) => `<option value="${p.id}"${p.id === note.project_id ? ' selected' : ''}>${esc(p.name)}</option>`)
    .join('');
  card.classList.add('is-editing');
  card.innerHTML = `<form class="note-edit log-form" data-id="${id}" autocomplete="off">
      <textarea class="note-edit-text" name="body" maxlength="10000" aria-label="Note" required>${esc(note.body)}</textarea>
      <div class="log-row">
        <select name="project_id" aria-label="Project">${options}</select>
        <button class="btn ghost" type="button" data-note-cancel>Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </div>
    </form>`;
  const area = card.querySelector('textarea');
  autosize(area, 480);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

function stopEditingNote() {
  state.editingNoteId = null;
  renderNotes();
}

async function deleteNote(id) {
  state.armed = null;
  const note = state.notes.find((n) => n.id === id);
  try {
    await api('DELETE', `/api/notes/${id}`);
    toast('Note deleted', 'Undo', async () => {
      try {
        await api('POST', '/api/notes', { project_id: note.project_id, body: note.body, pinned: note.pinned });
      } catch (err) {
        toast(err.message);
      }
      await load();
    });
  } catch (err) {
    toast(err.message);
  }
  await load();
}

function feedItem(entry) {
  const verb = VERB[entry.kind];
  const armKey = `log:${entry.id}`;
  const armed = isArmed(armKey);
  const remove = entry.kind === 'logged'
    ? `<button class="feed-delete${armed ? ' is-armed' : ''}" type="button" data-action="delete-log" data-id="${entry.id}" data-arm="${armKey}" aria-label="${armed ? 'Click again to delete this entry' : 'Delete this entry'}" title="${armed ? 'Click again to delete' : 'Delete'}">${armed ? '?' : '×'}</button>`
    : '<span></span>';
  return `<li class="feed-item kind-${entry.kind}">
    <time datetime="${esc(entry.at)}">${fmtTime.format(new Date(entry.at))}</time>
    <span class="dot" style="${swatch(entry.project_color)}"></span>
    <span class="feed-text">${verb ? `<span class="feed-verb">${verb}</span> ` : ''}${esc(entry.text)}${state.filter ? '' : ` <span class="feed-project">· ${esc(entry.project_name)}</span>`}${entry.source === 'auto' ? ' <span class="feed-auto" title="Added by the auto-update">auto</span>' : ''}</span>
    ${remove}
  </li>`;
}

// A day's daily status as lists, each with its place in `status.lists` for Copy. With the project filter
// on, only that project's list.
function statusLists(status) {
  const lists = (status?.lists ?? []).map((list, index) => ({ ...list, index }));
  return state.filter ? lists.filter((list) => list.project_id === state.filter) : lists;
}

function statusList(day, list) {
  return `<section class="status-list" style="${swatch(projectById(list.project_id)?.color)}">
    <header class="status-list-head">
      <h4>${esc(list.name)}</h4>
      <button class="note-action" type="button" data-action="copy-status" data-day="${day}" data-index="${list.index}" title="Copy these bullets to send to the client">Copy</button>
    </header>
    <ul>${list.bullets.map((bullet) => `<li>${esc(bullet)}</li>`).join('')}</ul>
  </section>`;
}

function statusMeta(status) {
  if (status?.status === 'running') return { text: 'Claude is writing…', title: '' };
  if (!status?.finished_at) return { text: '', title: '' };
  const at = new Date(status.finished_at);
  const bits = [status.model && modelName(status.model), status.cost_usd != null && `$${status.cost_usd.toFixed(2)}`].filter(Boolean);
  // Written on the day itself, the time says enough. Written later, it also says when.
  const when = localISO(at) === status.day ? '' : `${relativeDay(at)} `;
  return { text: `Written ${when}${fmtTime.format(at)}`, title: bits.join(' · ') };
}

// One day: its daily status from /daily-status, then the tracker's own entries, folded away under the
// status once there is one.
function feedDay({ key, entries, status }) {
  const lists = statusLists(status);
  const running = status?.status === 'running';
  const label = running ? 'Writing…' : status?.lists ? 'Update' : status ? 'Try again' : 'Write status';
  const meta = statusMeta(status);
  const note = !state.filter && status?.status !== 'running' && status?.note
    ? `<p class="status-note">${esc(status.note)}</p>`
    : '';
  const error = status?.status === 'failed'
    ? `<p class="status-error">${status.lists ? "Couldn't update it" : "Couldn't write it"}: ${esc(status.error)}</p>`
    : '';
  const open = !lists.length || state.openDays.has(key);
  const count = `${entries.length} tracker ${entries.length === 1 ? 'entry' : 'entries'}`;
  const toggle = lists.length && entries.length
    ? `<button class="feed-toggle" type="button" data-action="toggle-day" data-day="${key}" aria-expanded="${open}">${open ? 'Hide' : 'Show'} ${count}</button>`
    : '';
  const empty = !lists.length && !entries.length && !note && !error
    ? '<p class="feed-empty">Nothing yet. Finished tasks, the things you log and the daily status show up here.</p>'
    : '';
  return `<section class="feed-day">
    <header class="feed-day-head">
      <h3>${dayHeading(parseLocalDate(key))}</h3>
      <span class="feed-day-meta"${meta.title ? ` title="${esc(meta.title)}"` : ''}>${esc(meta.text)}</span>
      <button class="note-action" type="button" data-action="write-status" data-day="${key}"${running ? ' disabled' : ''} title="Claude runs /daily-status for this day">${label}</button>
    </header>
    ${lists.map((list) => statusList(key, list)).join('')}${note}${error}${toggle}${empty}
    ${entries.length && open ? `<ol class="feed-list">${entries.map(feedItem).join('')}</ol>` : ''}
  </section>`;
}

// A day at a time, newest first, always starting with today so its status can be written. Adding a task
// is planning, not doing, so the feed leaves those entries out.
function renderFeed() {
  const today = localISO();
  const days = new Map();
  const day = (key) => {
    if (!days.has(key)) days.set(key, { key, entries: [], status: null });
    return days.get(key);
  };
  day(today);
  for (const entry of visibleActivity()) if (entry.kind !== 'created') day(localISO(new Date(entry.at))).entries.push(entry);
  for (const status of state.dailyStatuses) day(status.day).status = status;
  const shown = [...days.values()]
    .filter((d) => d.key === today || d.entries.length || (state.filter ? statusLists(d.status).length : d.status))
    .sort((a, b) => (a.key < b.key ? 1 : -1));
  const listed = shown.slice(0, state.feedLimit);
  const more = shown.length - listed.length;
  $('feed').innerHTML = listed.map(feedDay).join('') + (more
    ? `<button class="btn ghost small feed-more" type="button" data-action="feed-more">Show ${Math.min(FEED_DAYS, more)} more ${Math.min(FEED_DAYS, more) === 1 ? 'day' : 'days'}</button>`
    : '');
}

function renderArchive() {
  const projects = archivedProjects();
  $('archive-count').textContent = projects.length;
  $('archive-list').innerHTML = projects.length
    ? projects.map((p) => {
      const armKey = `project:${p.id}`;
      const armed = isArmed(armKey);
      const tasks = `${p.total_count} ${p.total_count === 1 ? 'task' : 'tasks'}${p.open_count ? `, ${p.open_count} still open` : ''}`;
      return `<li class="archive-item">
        <span class="name"><span class="dot" style="${swatch(p.color)}"></span>${esc(p.name)}</span>
        <span class="meta">Archived ${shortDate(new Date(p.archived_at))} · ${tasks}</span>
        <span class="actions">
          <button class="btn small" type="button" data-action="restore" data-id="${p.id}">Restore</button>
          <button class="btn small danger-ghost${armed ? ' is-armed' : ''}" type="button" data-action="delete-project" data-id="${p.id}" data-arm="${armKey}">${armed ? 'Delete project and its tasks?' : 'Delete'}</button>
        </span>
      </li>`;
    }).join('')
    : '<li class="archive-empty">Nothing archived. When you stop working with a client, archive their project and it moves here.</li>';
}

// Actions

async function setStatus(id, status, { undoable = true } = {}) {
  const task = taskById(id);
  if (!task || task.status === status) return;
  const previous = { status: task.status, done_at: task.done_at };
  task.status = status;
  task.done_at = status === 'done' ? new Date().toISOString() : null;
  render();
  try {
    await api('PATCH', `/api/tasks/${id}`, { status });
    if (status === 'done' && undoable) {
      toast(`Finished “${truncate(task.title)}”`, 'Undo', () => setStatus(id, previous.status, { undoable: false }));
    }
  } catch (err) {
    Object.assign(task, previous);
    toast(err.message);
  }
  await load();
}

async function archiveProject(id) {
  const project = projectById(id);
  try {
    await api('PATCH', `/api/projects/${id}`, { archived: true });
    if (state.filter === id) setFilter(null, false);
    toast(`Archived ${project?.name ?? 'project'}`, 'Undo', () => restoreProject(id, { quiet: true }));
  } catch (err) {
    toast(err.message);
  }
  await load();
}

async function restoreProject(id, { quiet = false } = {}) {
  const project = projectById(id);
  try {
    await api('PATCH', `/api/projects/${id}`, { archived: false });
    if (!quiet) toast(`${project?.name ?? 'Project'} is active again`);
  } catch (err) {
    toast(err.message);
  }
  await load();
}

async function deleteProject(id) {
  const project = projectById(id);
  state.armed = null;
  try {
    await api('DELETE', `/api/projects/${id}`);
    toast(`Deleted ${project?.name ?? 'project'}`);
  } catch (err) {
    toast(err.message);
  }
  await load();
}

async function deleteLog(id) {
  state.armed = null;
  try {
    await api('DELETE', `/api/activity/${id}`);
    toast('Entry deleted');
  } catch (err) {
    toast(err.message);
  }
  await load();
}

async function writeStatus(day) {
  try {
    await api('POST', `/api/daily/${day}/run`, {});
    toast('Claude is writing the daily status. It takes a minute or two.');
  } catch (err) {
    toast(err.message);
  }
  await load();
}

// Just the bullets, ready to paste to that project's client.
async function copyStatus(day, index) {
  const list = state.dailyStatuses.find((s) => s.day === day)?.lists?.[index];
  if (!list) return;
  try {
    await navigator.clipboard.writeText(list.bullets.map((bullet) => `- ${bullet}`).join('\n'));
    toast(`Copied the ${list.name} list`);
  } catch {
    toast("Couldn't copy. Select the text instead.");
  }
}

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const id = Number(el.dataset.id);
  switch (el.dataset.action) {
    case 'filter':
      setFilter(state.filter === id ? null : id);
      break;
    case 'clear-filter':
      setFilter(null);
      break;
    case 'new-project':
      openProjectDialog();
      break;
    case 'edit-project':
      openProjectDialog(projectById(id));
      break;
    case 'archive':
      archiveProject(id);
      break;
    case 'restore':
      restoreProject(id);
      break;
    case 'delete-project':
      if (isArmed(`project:${id}`)) deleteProject(id);
      else arm(`project:${id}`);
      break;
    case 'edit-task':
      openTaskDialog(taskById(id));
      break;
    case 'toggle-done': {
      const task = taskById(id);
      if (task) setStatus(id, task.status === 'done' ? 'todo' : 'done');
      break;
    }
    case 'feed-more':
      state.feedLimit += FEED_DAYS;
      renderFeed();
      break;
    case 'toggle-day':
      if (!state.openDays.delete(el.dataset.day)) state.openDays.add(el.dataset.day);
      renderFeed();
      break;
    case 'write-status':
      writeStatus(el.dataset.day);
      break;
    case 'copy-status':
      copyStatus(el.dataset.day, Number(el.dataset.index));
      break;
    case 'notes-more':
      state.notesLimit += NOTES_PAGE;
      renderNotes();
      break;
    case 'toggle-note':
      if (!state.openNotes.delete(id)) state.openNotes.add(id);
      renderNotes();
      break;
    case 'pin-note': {
      const note = state.notes.find((n) => n.id === id);
      if (note) api('PATCH', `/api/notes/${id}`, { pinned: !note.pinned }).then(load, (err) => toast(err.message));
      break;
    }
    case 'edit-note':
      if (state.editingNoteId) {
        document.querySelector('.note-edit-text')?.focus();
        toast("Save or cancel the note you're editing first");
      } else {
        startEditingNote(id);
      }
      break;
    case 'delete-note':
      if (isArmed(`note:${id}`)) deleteNote(id);
      else arm(`note:${id}`);
      break;
    case 'open-review':
      openReviewDialog(id);
      break;
    case 'request-review':
      requestReview(el.dataset.url);
      break;
    case 'merge-pr':
      if (isArmed(`merge:${el.dataset.url}`)) mergePr(el.dataset.url);
      else arm(`merge:${el.dataset.url}`);
      break;
    case 'toggle-pr-lane': {
      const { group } = el.dataset;
      if (!state.openPrLanes.delete(group)) state.openPrLanes.add(group);
      renderPulls();
      break;
    }
    case 'delete-log':
      if (isArmed(`log:${id}`)) deleteLog(id);
      else arm(`log:${id}`);
      break;
  }
});

// Drag and drop between lanes. On touch screens, use the check button or the task dialog instead.

const board = $('board');

board.addEventListener('dragstart', (event) => {
  const card = event.target.closest?.('.task');
  if (!card) return;
  state.dragging = true;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', card.dataset.id);
  requestAnimationFrame(() => card.classList.add('is-dragging'));
});

board.addEventListener('dragend', (event) => {
  state.dragging = false;
  event.target.closest?.('.task')?.classList.remove('is-dragging');
  board.querySelectorAll('.lane.is-over').forEach((lane) => lane.classList.remove('is-over'));
});

board.addEventListener('dragover', (event) => {
  const lane = event.target.closest('.lane');
  if (!lane || !state.dragging) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  board.querySelectorAll('.lane.is-over').forEach((other) => other !== lane && other.classList.remove('is-over'));
  lane.classList.add('is-over');
});

board.addEventListener('dragleave', (event) => {
  const lane = event.target.closest('.lane');
  if (lane && !lane.contains(event.relatedTarget)) lane.classList.remove('is-over');
});

board.addEventListener('drop', (event) => {
  const lane = event.target.closest('.lane');
  if (!lane) return;
  event.preventDefault();
  lane.classList.remove('is-over');
  state.dragging = false;
  const id = Number(event.dataTransfer.getData('text/plain'));
  if (id) setStatus(id, lane.dataset.status);
});

// Log form

$('log-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('log-text').value.trim();
  const projectId = Number($('log-project').value);
  if (!text || !projectId) return;
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    await api('POST', '/api/activity', { project_id: projectId, text });
    $('log-text').value = '';
    storage.set('logProject', projectId);
    // Unfold today's entries, so the one just logged doesn't vanish under the daily status.
    state.openDays.add(localISO());
    toast('Logged');
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});

// Notes: the box at the top of the sidebar, and editing a note in place.

const noteText = $('note-text');
const saveOnCommandEnter = (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    event.target.form.requestSubmit();
  }
};

noteText.addEventListener('keydown', saveOnCommandEnter);
noteText.addEventListener('input', () => {
  autosize(noteText, 600);
  storage.set('noteDraft', noteText.value || null);
});

$('note-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = noteText.value.trim();
  const projectId = Number($('note-project').value);
  if (!body || !projectId) return;
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    await api('POST', '/api/notes', { project_id: projectId, body });
    noteText.value = '';
    autosize(noteText, 600);
    storage.set('noteDraft', null);
    storage.set('noteProject', projectId);
    toast('Note saved');
    await load();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
});

$('notes').addEventListener('keydown', (event) => {
  if (!event.target.matches('.note-edit-text')) return;
  if (event.key === 'Escape') stopEditingNote();
  else saveOnCommandEnter(event);
});

$('notes').addEventListener('input', (event) => {
  if (event.target.matches('.note-edit-text')) autosize(event.target, 480);
});

$('notes').addEventListener('click', (event) => {
  if (event.target.closest('[data-note-cancel]')) stopEditingNote();
});

$('notes').addEventListener('submit', async (event) => {
  const form = event.target.closest('.note-edit');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await api('PATCH', `/api/notes/${form.dataset.id}`, { body: data.get('body'), project_id: Number(data.get('project_id')) });
    state.editingNoteId = null;
    toast('Note saved');
    await load();
  } catch (err) {
    toast(err.message);
    button.disabled = false;
  }
});

// Dialogs

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
  });
}

function showFormError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = !message;
}

const taskDialog = $('task-dialog');
const taskForm = $('task-form');
const taskDelete = $('task-delete');
let editingTaskId = null;

function disarmTaskDelete() {
  clearTimeout(taskDelete.timer);
  taskDelete.classList.remove('is-armed');
  taskDelete.textContent = 'Delete';
}

function openTaskDialog(task) {
  const projects = activeProjects();
  if (!projects.length) {
    toast('Add a project first');
    openProjectDialog();
    return;
  }
  editingTaskId = task?.id ?? null;
  $('task-dialog-title').textContent = task ? 'Edit task' : 'New task';
  $('task-submit').textContent = task ? 'Save' : 'Add task';
  taskDelete.hidden = !task;
  disarmTaskDelete();

  const select = $('task-project');
  select.innerHTML = projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const preferred = task?.project_id ?? state.filter ?? Number(storage.get('taskProject'));
  select.value = String(projects.some((p) => p.id === preferred) ? preferred : projects[0].id);

  $('task-title').value = task?.title ?? '';
  $('task-due').value = task?.due_date ?? '';
  $('task-link').value = task?.link ?? '';
  $('task-notes').value = task?.notes ?? '';
  taskForm.querySelector(`input[name="status"][value="${task?.status ?? 'todo'}"]`).checked = true;
  taskForm.querySelector(`input[name="priority"][value="${task?.priority ?? 'normal'}"]`).checked = true;
  showFormError('task-error', '');
  taskDialog.showModal();
  $('task-title').focus();
}

taskForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(taskForm);
  const body = {
    title: data.get('title'),
    project_id: Number(data.get('project_id')),
    status: data.get('status'),
    priority: data.get('priority'),
    due_date: data.get('due_date') || null,
    link: data.get('link').trim(),
    notes: data.get('notes'),
  };
  const submit = $('task-submit');
  submit.disabled = true;
  try {
    if (editingTaskId) {
      await api('PATCH', `/api/tasks/${editingTaskId}`, body);
      toast('Saved');
    } else {
      await api('POST', '/api/tasks', body);
      storage.set('taskProject', body.project_id);
      toast('Task added');
    }
    taskDialog.close();
    await load();
  } catch (err) {
    showFormError('task-error', err.message);
  } finally {
    submit.disabled = false;
  }
});

taskDelete.addEventListener('click', async () => {
  if (!taskDelete.classList.contains('is-armed')) {
    taskDelete.classList.add('is-armed');
    taskDelete.textContent = 'Click again to delete';
    taskDelete.timer = setTimeout(disarmTaskDelete, ARM_MS);
    return;
  }
  try {
    const { ignored_link: fromTicket } = await api('DELETE', `/api/tasks/${editingTaskId}`);
    taskDialog.close();
    toast(fromTicket ? "Task deleted. The auto-update won't add it back." : 'Task deleted');
    await load();
  } catch (err) {
    showFormError('task-error', err.message);
  }
});

const projectDialog = $('project-dialog');
const projectForm = $('project-form');
let editingProjectId = null;

function openProjectDialog(project) {
  editingProjectId = project?.id ?? null;
  $('project-dialog-title').textContent = project ? 'Edit project' : 'New project';
  $('project-submit').textContent = project ? 'Save' : 'Add project';
  $('project-archive').hidden = !project || project.is_common;
  $('project-name').value = project?.name ?? '';
  $('project-jira').value = project?.jira_site ?? '';
  $('project-linear').value = project?.linear_team ?? '';
  const used = new Set(activeProjects().map((p) => p.color));
  const selected = project?.color ?? COLORS.find((c) => !used.has(c)) ?? COLORS[0];
  $('project-colors').innerHTML = COLORS.map((c) => `<label>
      <input type="radio" name="color" value="${c}" aria-label="${c}"${c === selected ? ' checked' : ''}>
      <span style="${swatch(c)}"></span>
    </label>`).join('');
  showFormError('project-error', '');
  projectDialog.showModal();
  $('project-name').focus();
}

projectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(projectForm);
  const body = {
    name: data.get('name'),
    color: data.get('color'),
    jira_site: data.get('jira_site'),
    linear_team: data.get('linear_team'),
  };
  const submit = $('project-submit');
  submit.disabled = true;
  try {
    if (editingProjectId) {
      await api('PATCH', `/api/projects/${editingProjectId}`, body);
      toast('Saved');
    } else {
      await api('POST', '/api/projects', body);
      toast(`Added ${body.name.trim()}`);
    }
    projectDialog.close();
    await load();
  } catch (err) {
    showFormError('project-error', err.message);
  } finally {
    submit.disabled = false;
  }
});

$('project-archive').addEventListener('click', () => {
  projectDialog.close();
  archiveProject(editingProjectId);
});

$('new-task').addEventListener('click', () => openTaskDialog());
$('new-project').addEventListener('click', () => openProjectDialog());

document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'n' || event.metaKey || event.ctrlKey || event.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (event.target.closest('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  openTaskDialog();
});

// Toast

// Claude's review of a PR

const reviewDialog = $('review-dialog');
const reviewText = $('review-text');
let openReview = null;
let armedPost = null;

const modelName = (model) => model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^\w/, (c) => c.toUpperCase());

// Claude's plain text: paragraphs on blank lines, `code` spans and **bold**.
function richText(text) {
  return text.split(/\n\s*\n/).filter((p) => p.trim()).map((p) => `<p>${esc(p.trim())
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>')}</p>`).join('');
}

function reviewMeta(review) {
  const bits = [];
  if (review.model) bits.push(esc(modelName(review.model)));
  if (review.started_at && review.finished_at) {
    bits.push(`${Math.max(1, Math.round((new Date(review.finished_at) - new Date(review.started_at)) / 60_000))} min`);
  }
  if (review.cost_usd != null) bits.push(`$${review.cost_usd.toFixed(2)}`);
  if (review.finished_at) {
    const at = new Date(review.finished_at);
    bits.push(`${relativeDay(at)} at ${fmtTime.format(at)}`);
  }
  if (review.outdated) bits.push('<span class="tag warn">New commits since this review</span>');
  if (review.posted_as) bits.push(`<span class="tag good">Posted: ${esc(REVIEW_EVENTS[review.posted_as].label.toLowerCase())}</span>`);
  return bits.join(' · ');
}

function disarmReviewPost() {
  armedPost = null;
  clearTimeout(disarmReviewPost.timer);
  for (const button of $('review-actions').querySelectorAll('[data-post]')) {
    button.classList.remove('is-armed');
    button.textContent = REVIEW_EVENTS[button.dataset.post].label;
  }
}

function setReviewBusy(busy) {
  for (const button of reviewDialog.querySelectorAll('.sheet-foot button')) button.disabled = busy;
}

function openReviewDialog(id) {
  const pr = state.github?.prs.find((p) => p.review?.id === id);
  if (!pr) return;
  const { review } = pr;
  openReview = { id, url: pr.url, body: review.body, dismissed: review.dismissed, comments: [] };
  const [, repo] = pr.repo.split('/');
  const link = $('review-pr');
  link.textContent = `${repo}#${pr.number} · ${pr.title} · by ${pr.author}`;
  link.href = safeLink(pr.url) ?? '#';
  const failed = review.status === 'failed';
  const { summary, notes, post, comments, verdict } = failed
    ? { summary: '', notes: '', post: '', comments: [], verdict: null }
    : reviewParts(review);
  const summaryEl = $('review-summary');
  summaryEl.innerHTML = failed
    ? `<p class="review-failed">${esc(review.error ?? 'The review failed')}</p>`
    : richText(summary) + (notes ? `<div class="review-notes"><p class="review-notes-label">Only for you, not posted</p>${richText(notes)}</div>` : '');
  summaryEl.hidden = !failed && !summary && !notes;
  reviewText.value = post;
  $('review-text-hint').textContent = review.draft
    ? "the verdict, and findings that aren't on a changed line; edit before posting"
    : 'the verdict and findings; edit before posting';
  openReview.comments = comments.map((c) => ({ ...c, leftOut: false }));
  renderReviewComments();
  for (const part of ['review-post-field', 'review-actions', 'review-dismiss', 'review-copy']) $(part).hidden = failed;
  $('review-comments-field').hidden = failed || !comments.length;
  // GitHub's search can take a minute to drop the PR from the lane after a review is posted.
  if (review.posted_as) $('review-actions').hidden = true;
  // After a "Looks good" review you can approve with the text below or without any.
  const positive = verdict?.tone === 'good';
  for (const button of $('review-actions').querySelectorAll('[data-post^="approve"]')) {
    button.hidden = (button.dataset.post === 'approve') === positive;
  }
  $('review-again').textContent = failed ? 'Try again' : 'Review again';
  $('review-dismiss').textContent = review.dismissed ? 'Restore' : 'Dismiss';
  $('review-meta').innerHTML = reviewMeta(review);
  showFormError('review-error', '');
  disarmReviewPost();
  setReviewBusy(false);
  reviewDialog.showModal();
  if (!failed) {
    autosize(reviewText, Math.round(innerHeight * 0.5));
    reviewText.scrollTop = 0;
    for (const area of $('review-comments').querySelectorAll('textarea')) autosize(area, 240);
  }
}

const commentPlace = (c) => `${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line}${c.side === 'LEFT' ? ' (old file)' : ''}`;

function renderReviewComments() {
  $('review-comments').innerHTML = openReview.comments.map((c, index) => `
    <div class="review-comment${c.leftOut ? ' is-left-out' : ''}" data-index="${index}">
      <div class="review-comment-head">
        <code>${esc(commentPlace(c)).replace(/\//g, '/<wbr>')}</code>
        <button class="btn ghost small" type="button" data-comment-toggle>${c.leftOut ? 'Put back' : 'Leave out'}</button>
      </div>
      <textarea rows="2" maxlength="20000" aria-label="Comment on ${esc(commentPlace(c))}"${c.leftOut ? ' disabled' : ''}>${esc(c.body)}</textarea>
    </div>`).join('');
}

// The line comments that go out with the review.
const keptComments = () => openReview.comments
  .filter((c) => !c.leftOut)
  .map(({ path, line, start_line: startLine, side, body }) => ({ path, line, ...(startLine ? { start_line: startLine } : {}), side, body }));

async function requestReview(url) {
  try {
    await api('POST', '/api/reviews', { url });
    toast('Claude is reviewing it. This takes a few minutes.');
  } catch (err) {
    toast(err.message);
  }
  await loadGithub();
}

reviewDialog.addEventListener('close', () => {
  disarmReviewPost();
  openReview = null;
});

reviewText.addEventListener('input', () => autosize(reviewText, Math.round(innerHeight * 0.5)));

$('review-comments').addEventListener('input', (event) => {
  const item = event.target.closest('.review-comment');
  if (!item || !openReview || event.target.tagName !== 'TEXTAREA') return;
  openReview.comments[Number(item.dataset.index)].body = event.target.value;
  autosize(event.target, 240);
});

$('review-comments').addEventListener('click', (event) => {
  const button = event.target.closest('[data-comment-toggle]');
  if (!button || !openReview) return;
  const index = Number(button.closest('.review-comment').dataset.index);
  openReview.comments[index].leftOut = !openReview.comments[index].leftOut;
  renderReviewComments();
  for (const area of $('review-comments').querySelectorAll('textarea')) autosize(area, 240);
  disarmReviewPost();
});

// Posting goes out under the user's name, so each button asks once more before it posts.
$('review-actions').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-post]');
  if (!button || !openReview) return;
  const kind = button.dataset.post;
  const action = REVIEW_EVENTS[kind];
  const comments = action.bare ? [] : keptComments();
  // The server would post an approval with empty text without complaint.
  if (action.needsText && !reviewText.value.trim() && !comments.length) {
    disarmReviewPost();
    showFormError('review-error', 'Write the comment first, or use Just approve.');
    return;
  }
  const empty = comments.find((c) => !c.body.trim());
  if (empty) {
    disarmReviewPost();
    showFormError('review-error', `Write the comment on ${commentPlace(empty)}, or leave it out.`);
    return;
  }
  if (armedPost !== kind) {
    disarmReviewPost();
    showFormError('review-error', '');
    armedPost = kind;
    button.classList.add('is-armed');
    button.textContent = action.confirm;
    disarmReviewPost.timer = setTimeout(disarmReviewPost, ARM_MS);
    return;
  }
  disarmReviewPost();
  setReviewBusy(true);
  const { id, url } = openReview;
  try {
    await api('POST', `/api/reviews/${id}/post`, { event: action.event ?? kind, body: action.bare ? '' : reviewText.value, comments });
    reviewDialog.close();
    const pr = state.github?.prs.find((p) => p.url === url);
    const onLines = comments.length ? ` with ${comments.length} line comment${comments.length === 1 ? '' : 's'}` : '';
    toast(`${REVIEW_EVENTS[kind].done} ${pr ? `${pr.repo.split('/')[1]}#${pr.number}` : 'the PR'}${onLines}`);
    await loadGithub();
  } catch (err) {
    showFormError('review-error', err.message);
    setReviewBusy(false);
  }
});

$('review-again').addEventListener('click', async () => {
  if (!openReview) return;
  const { url } = openReview;
  reviewDialog.close();
  await requestReview(url);
});

$('review-dismiss').addEventListener('click', async () => {
  if (!openReview) return;
  const { id, dismissed } = openReview;
  setReviewBusy(true);
  try {
    await api('PATCH', `/api/reviews/${id}`, { dismissed: !dismissed });
    reviewDialog.close();
  } catch (err) {
    showFormError('review-error', err.message);
    setReviewBusy(false);
  }
  await loadGithub();
});

$('review-copy').addEventListener('click', async () => {
  if (!openReview) return;
  try {
    await navigator.clipboard.writeText(openReview.body);
    toast('Copied the whole review');
  } catch {
    toast("Couldn't copy. Select the text instead.");
  }
});

let toastTimer;

function hideToast() {
  $('toast').hidden = true;
}

function toast(message, actionLabel, action) {
  $('toast-text').textContent = message;
  const button = $('toast-action');
  button.hidden = !actionLabel;
  button.textContent = actionLabel ?? '';
  button.onclick = actionLabel
    ? () => {
      hideToast();
      action();
    }
    : null;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 3000);
}

// Theme

const MOON = '<path d="M10 3a7 7 0 1 0 7 7 5.5 5.5 0 0 1-7-7Z" />';
const SUN = '<circle cx="10" cy="10" r="3.2" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

const currentTheme = () => document.documentElement.dataset.theme ?? (darkQuery.matches ? 'dark' : 'light');

function updateThemeButton() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  const button = $('theme-toggle');
  button.setAttribute('aria-label', `Switch to ${next} theme`);
  button.querySelector('svg').innerHTML = next === 'dark' ? MOON : SUN;
}

$('theme-toggle').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  storage.set('theme', next);
  updateThemeButton();
});

darkQuery.addEventListener('change', updateThemeButton);

// Start

$('refresh-all').addEventListener('click', refreshAll);
$('run-reviews').addEventListener('click', runReviews);
$('prs-stale').addEventListener('click', () => {
  state.showStalePrs = !state.showStalePrs;
  storage.set('showStalePrs', state.showStalePrs ? '1' : null);
  renderPulls();
});

state.filter = Number(storage.get('filter')) || null;
state.showStalePrs = storage.get('showStalePrs') === '1';
noteText.value = storage.get('noteDraft') ?? '';
if (noteText.value) autosize(noteText, 600);
updateThemeButton();
load();
loadGithub();

setInterval(() => {
  if (document.visibilityState === 'visible' && !state.dragging) load();
}, REFRESH_MS);

// The server caches GitHub for a minute, so polling here never asks GitHub more often than that.
setInterval(() => {
  if (document.visibilityState === 'visible') loadGithub();
}, GITHUB_REFRESH_MS);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    load();
    loadGithub();
  }
});

new ResizeObserver(() => {
  if (state.loaded && $('chart').clientWidth !== chartWidth) renderChart();
}).observe($('chart'));
