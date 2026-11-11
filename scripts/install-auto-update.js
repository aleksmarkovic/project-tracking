#!/usr/bin/env node
// Installs the launchd job that starts scripts/auto-update.js on the hour and half hour. The script
// itself decides which of those do any work (lib/schedule.js).
// `--uninstall` removes it. Re-run after moving the repo or switching Node versions, because the
// job stores absolute paths.
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'local.project-tracking.auto-update';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_DIR = join(homedir(), 'Library', 'Logs', 'project-tracking');
const DOMAIN = `gui/${userInfo().uid}`;

const xml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function launchctl(...args) {
  try {
    execFileSync('launchctl', args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

if (process.argv.includes('--uninstall')) {
  launchctl('bootout', `${DOMAIN}/${LABEL}`);
  await rm(PLIST, { force: true });
  console.log('Removed the auto-update.');
  process.exit(0);
}

// launchd starts jobs with a bare PATH, so give it the folders the run needs:
// node, claude (~/.local/bin), and git, gh and python3.
const PATH = [
  dirname(process.execPath),
  join(homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(join(ROOT, 'scripts', 'auto-update.js'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(PATH)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Minute</key>
      <integer>0</integer>
    </dict>
    <dict>
      <key>Minute</key>
      <integer>30</integer>
    </dict>
  </array>
  <key>StandardOutPath</key>
  <string>${xml(join(LOG_DIR, 'launchd.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(LOG_DIR, 'launchd.log'))}</string>
</dict>
</plist>
`;

await mkdir(dirname(PLIST), { recursive: true });
await mkdir(LOG_DIR, { recursive: true });
await writeFile(PLIST, plist);
launchctl('bootout', `${DOMAIN}/${LABEL}`);
if (!launchctl('bootstrap', DOMAIN, PLIST)) {
  console.error(`Wrote ${PLIST} but launchctl couldn't load it. Try: launchctl bootstrap ${DOMAIN} "${PLIST}"`);
  process.exit(1);
}
console.log(`Installed. The auto-update runs every 30 minutes, Mon-Fri 09:00-19:00 (see lib/schedule.js).
Job:  ${PLIST}
Log:  ${join(LOG_DIR, 'auto-update.log')}
Run it now: npm run auto:run`);
