// The user's /daily-status skill (~/.claude/skills/daily-status) for each day, so the sidebar's "What I
// did" shows what the user did that day as one client-ready list per project. Claude writes it
// headlessly and read-only: today's at each slot of the schedule, the last day before today once more
// after it ended (work after the 19:00 slot would be missing otherwise), and any day when the user
// clicks Write status or Update. One run at a time. Nothing leaves the page; the user copies a list
// to send it.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BusyError, ClaudeError, askClaude } from './claude.js';
import { EVERY, everySlot, slotStart } from './schedule.js';
import * as store from './store.js';

const MODEL = 'sonnet';
const MAX_BUDGET_USD = 1;
const TIMEOUT_MS = 10 * 60_000;
const GATHER = join(homedir(), '.claude', 'skills', 'daily-status', 'scripts', 'gather_local.py');

// What the run returns instead of the skill's chat answer (see systemPrompt).
const SCHEMA = {
  type: 'object',
  properties: {
    lists: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          name: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['project', 'name', 'bullets'],
        additionalProperties: false,
      },
    },
    note: { type: 'string' },
  },
  required: ['lists', 'note'],
  additionalProperties: false,
};

// Everything not listed is refused in dontAsk mode, so the run can gather the day's work and read
// Jira and Confluence, nothing else. The skill's own text runs the script through `~`, hence both paths.
const ARGS = [
  '--model', MODEL,
  '--max-budget-usd', String(MAX_BUDGET_USD),
  '--permission-mode', 'dontAsk',
  '--allowedTools', 'Skill', 'ToolSearch',
  `Bash(python3 ${GATHER} *)`, 'Bash(python3 ~/.claude/skills/daily-status/scripts/gather_local.py *)',
  ...['getAccessibleAtlassianResources', 'atlassianUserInfo', 'searchJiraIssuesUsingJql', 'searchConfluenceUsingCql', 'getJiraIssue']
    .map((tool) => `mcp__claude_ai_Atlassian_Rovo__${tool}`),
  '--json-schema', JSON.stringify(SCHEMA),
];

const fmtDay = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function localISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Local midnight at the start of `day`, or of the day after with `plusDays`.
function midnight(day, plusDays = 0) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + plusDays);
}

function systemPrompt(day) {
  const today = day === localISO(new Date());
  return `This run writes the user's daily status for ${fmtDay.format(midnight(day))} (${day}) for their tracker page. `
    + "Nobody is watching it and nobody can answer questions. Only read: don't change anything in Jira, Confluence or anywhere else.\n\n"
    + `Gather local activity with exactly \`python3 ${GATHER} --date ${day}\`.`
    + (today ? '' : ` In Jira and Confluence, look at ${day} only, using that day's date range instead of startOfDay().`)
    + '\n\nInstead of the chat answer, return the lists through the structured output, in the order you would write them:\n'
    + "- lists: one per project. `project` is the `## ` heading the script printed for it (the folder name, e.g. "
    + '`acme-co`), `name` the bold client name, and `bullets` the bullets without the leading dash.\n'
    + "- note: the line you would put under the lists, such as a source that failed. Empty when there's nothing to say. "
    + 'When nothing turned up at all, return no lists and say so here.';
}

// The skill's own format, for a run that answered in text instead: the client's name in bold on its
// own line, then "- " bullets.
function listsOfText(text) {
  const lists = [];
  for (const row of text.split('\n')) {
    const heading = row.match(/^\s*\*\*(.+?)\*\*\s*$/);
    const bullet = row.match(/^\s*[-*]\s+(.+)$/);
    if (heading) lists.push({ project: heading[1], name: heading[1], bullets: [] });
    else if (bullet && lists.length) lists.at(-1).bullets.push(bullet[1]);
  }
  return lists;
}

// The tracker project a list is about, by its folder or its name, or null when none matches.
async function projectIdOf(list) {
  for (const ref of [list.project, list.name]) {
    try {
      return (await store.findProject(ref)).id;
    } catch (err) {
      if (!(err instanceof store.InputError || err instanceof store.NotFoundError)) throw err;
    }
  }
  return null;
}

async function shapeLists(raw) {
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const lists = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const bullets = (Array.isArray(item?.bullets) ? item.bullets : []).map(text).filter(Boolean);
    const list = { project: text(item?.project), name: text(item?.name) || text(item?.project), bullets };
    if (!list.name || !bullets.length) continue;
    lists.push({ ...list, project_id: await projectIdOf(list) });
  }
  return lists;
}

async function write(day) {
  try {
    const result = await askClaude([...ARGS, '--append-system-prompt', systemPrompt(day)], `/daily-status ${day}`, {
      timeoutMs: TIMEOUT_MS,
    });
    const output = result.structured_output;
    const structured = output && typeof output === 'object';
    // Without structured output, keep the text rather than throw away a paid run.
    const body = structured ? '' : String(result.result ?? '').trim();
    const lists = await shapeLists(structured ? output.lists : listsOfText(body));
    const note = structured && typeof output.note === 'string' ? output.note.trim() : '';
    if (!structured && !lists.length && !body) throw new ClaudeError("Claude didn't write a status");
    const models = Object.keys(result.modelUsage ?? {});
    await store.finishDailyStatus(day, {
      lists,
      note: note || (!lists.length ? body : ''),
      body,
      model: models.find((m) => m.includes(MODEL)) ?? models[0] ?? MODEL,
      costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
    });
  } catch (err) {
    if (!(err instanceof ClaudeError)) console.error(err);
    await store.failDailyStatus(day, err.message);
  }
}

let running = false;

// Writes each day's status in turn, in the background. Resolves once the first is marked as being
// written, so the page shows it straight away.
function start(days) {
  if (running) throw new BusyError('Claude is already writing a daily status. Try again when it has finished.');
  running = true;
  const [first, ...rest] = days;
  const marked = store.startDailyStatus(first);
  marked
    .then(async () => {
      await write(first);
      for (const day of rest) {
        await store.startDailyStatus(day);
        await write(day);
      }
    })
    .catch((err) => console.error(`Daily status: ${err.message}`))
    .finally(() => {
      running = false;
    });
  return marked;
}

// 'YYYY-MM-DD' → starts writing that day's status, from Write status or Update on the page.
export function requestDailyStatus(day) {
  return start([store.statusDay(day)]);
}

// Today's status, after the last day before today once more if it was written before that day ended
// and hasn't been retried today. Each is written once per slot, so a server restart (or `npm run dev`
// reloading) during a slot hour doesn't pay for another run.
async function scheduled() {
  if (running) return;
  const now = new Date();
  const today = localISO(now);
  const slot = slotStart(now, EVERY.daily) ?? now;
  const [latest, previous] = await store.listDailyStatuses({ limit: 2 });
  const todays = latest?.day === today ? latest : null;
  const last = todays ? previous : latest;
  const ended = last?.status === 'done' && last.finished_at >= midnight(last.day, 1);
  const days = [];
  if (last && !ended && last.started_at < midnight(today)) days.push(last.day);
  if (!todays || todays.started_at < slot) days.push(today);
  if (days.length) await start(days);
}

// Called once the server is up.
export async function startDailyStatuses() {
  await store.failInterruptedDailyStatuses();
  everySlot(EVERY.daily, () => scheduled().catch((err) => console.error(`Scheduled daily status: ${err.message}`)));
}
