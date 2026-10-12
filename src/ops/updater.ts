import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Admin "update the server" button. The web process is unprivileged (and sandboxed with NoNewPrivileges), so it never runs sudo itself:
 * it only drops a request file. A root-owned systemd path unit (deploy/hearthkeeper-update.path) sees the file and runs `make update` in its
 * own unit, which survives the app restart that `make update` triggers, and logs between "== update started" / "== update finished" markers.
 */
export interface AdminConfig { emails: string[]; requestFile: string; logFile: string; /** Present only when the systemd units are installed. Omit to skip the check (tests). */ unitFile?: string }
export type UpdateState = 'never' | 'running' | 'ok' | 'failed';
export interface UpdateLog { state: UpdateState; startedAt: string | null; finishedAt: string | null; tail: string }

const TAIL_LINES = 40;

export function parseUpdateLog(text: string): UpdateLog {
  const lines = text.split('\n');
  let start = -1;
  lines.forEach((l, i) => { if (l.startsWith('== update started')) start = i; });
  if (start < 0) return { state: 'never', startedAt: null, finishedAt: null, tail: '' };
  const run = lines.slice(start).filter((l, i, a) => l !== '' || i < a.length - 1);
  const fin = run.find((l) => l.startsWith('== update finished'));
  const tail = run.slice(-TAIL_LINES).join('\n');
  return {
    state: !fin ? 'running' : /^== update finished ok/.test(fin) ? 'ok' : 'failed',
    startedAt: run[0].replace('== update started', '').trim() || null,
    finishedAt: fin ? fin.replace(/^== update finished (ok|failed( \(exit \d+\))?)/, '').trim() || null : null,
    tail,
  };
}

export const isAdmin = (cfg: AdminConfig | undefined, user: string | undefined) => !!cfg && !!user && cfg.emails.some((e) => e.toLowerCase() === user.toLowerCase());

export function updateStatus(cfg: AdminConfig) {
  const log = parseUpdateLog(existsSync(cfg.logFile) ? readFileSync(cfg.logFile, 'utf8') : '');
  return { admin: true as const, ready: cfg.unitFile ? existsSync(cfg.unitFile) : true, pending: existsSync(cfg.requestFile), ...log };
}

/** Drop the request file. Returns an error string when it should not be requested right now. */
export function requestUpdate(cfg: AdminConfig, by: string): string | null {
  const s = updateStatus(cfg);
  if (!s.ready) return 'The server is not set up for one-button updates yet. Run "sudo make update" on the VM once first.';
  if (s.pending) return 'An update is already requested.';
  if (s.state === 'running') return 'An update is already running.';
  try { writeFileSync(cfg.requestFile, JSON.stringify({ by, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); } // 'wx': never follow or overwrite an existing path
  catch { return 'An update is already requested.'; }
  return null;
}
