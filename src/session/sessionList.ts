import { execFile } from "child_process";
import { cliCommand } from "../cli/locate";
import { AcpSessionRow } from "../acp/types";

export interface DevinSession {
  id: string;
  short_id: string;
  working_directory: string;
  last_activity_at?: number;
  last_activity_ago?: string;
  title?: string;
  tracked?: boolean;
}

interface ListOptions {
  cliPath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  // Session ids this VS Code window already knows (from workspaceState).
  trackedIds: string[];
  // Exact directory each tracked id was created in.
  cwdById: Record<string, string>;
  // Workspace folders, queried to discover sessions created by another window.
  folders: string[];
}

export interface ListResult {
  // Sessions Devin knows about, including ones this window just discovered.
  sessions: DevinSession[];
  // Tracked ids Devin no longer knows about, safe to drop from the store.
  prunedIds: string[];
}

const LIST_CONCURRENCY = 4;

// `devin list --format json` is exact-match on cwd, so query every workspace
// folder plus each directory remembered for an existing session. Ids whose
// directory was queried successfully but no longer contains them are pruned.
// Failed directories are left untouched so a transient error never wipes the list.
export async function listSessions(opts: ListOptions): Promise<ListResult> {
  const dirs = new Set<string>();
  for (const folder of opts.folders) {
    dirs.add(folder);
  }
  for (const id of opts.trackedIds) {
    const cwd = opts.cwdById[id];
    if (cwd) {
      dirs.add(cwd);
    }
  }
  if (dirs.size === 0) {
    dirs.add(process.cwd());
  }

  const dirList = [...dirs];
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  const queried = await mapLimited(
    dirList,
    LIST_CONCURRENCY,
    (d) => runList(opts.cliPath, d, opts.env, Math.max(1, deadline - Date.now())),
    deadline
  );

  const byId = new Map<string, DevinSession>();
  const okDirs = new Set<string>();
  queried.forEach((res, i) => {
    const dir = dirList[i];
    if (!res?.ok) {
      return;
    }
    okDirs.add(dir);
    for (const s of res.sessions) {
      if (s && s.id && !byId.has(s.id)) {
        byId.set(s.id, s);
      }
    }
  });

  const tracked = new Set(opts.trackedIds);
  const sessions: DevinSession[] = [...byId.values()].map((session) => ({
    ...session,
    tracked: tracked.has(session.id)
  }));
  const prunedIds: string[] = [];
  for (const id of opts.trackedIds) {
    const found = byId.get(id);
    if (found) {
      continue;
    }
    // Absent: prune only if the directory we expected it in was queried
    // successfully (so we know it is genuinely gone, not a failed call).
    const cwd = opts.cwdById[id];
    const dirKnown = cwd ? okDirs.has(cwd) : okDirs.size === dirs.size;
    if (dirKnown) {
      prunedIds.push(id);
    }
  }

  sessions.sort((a, b) => (b.last_activity_at || 0) - (a.last_activity_at || 0));
  return { sessions, prunedIds };
}

// The same listing, taken over ACP (`session/list`) instead of by spawning
// `devin list` once per directory. The protocol call is not scoped to a directory,
// so it can find a session created by another VS Code window or workspace folder.
//
// Return every session so a new VS Code window can discover chats created by another
// window. The tracked flag lets the caller persist the directory needed to reopen it.
export function fromAcpRows(rows: AcpSessionRow[], trackedIds: string[]): ListResult {
  const byId = new Map(rows.filter((r) => r && r.sessionId).map((r) => [r.sessionId, r]));
  const tracked = new Set(trackedIds);
  const sessions: DevinSession[] = [...byId.values()].map((row) => ({
    id: row.sessionId,
    short_id: row.sessionId,
    working_directory: row.cwd || "",
    last_activity_at: epochSeconds(row.updatedAt),
    title: row.title,
    tracked: tracked.has(row.sessionId)
  }));
  const prunedIds: string[] = [];
  // An agent that can answer this at all has at least its own session to report, so
  // no rows is a protocol answer that cannot be true, not a fact about the user's
  // sessions. Believing it pruned the whole workspace list, and with it every
  // session's recorded directory and unsent draft, which nothing can bring back.
  // The CLI path guards the same way, per directory.
  const usable = byId.size > 0;
  for (const id of trackedIds) {
    const row = byId.get(id);
    if (!row) {
      // One answer covering every directory, so an id that is absent here is gone,
      // with none of the "was that directory queried successfully" doubt the CLI
      // path has to allow for.
      if (usable) {
        prunedIds.push(id);
      }
      continue;
    }
  }
  sessions.sort((a, b) => (b.last_activity_at || 0) - (a.last_activity_at || 0));
  return { sessions, prunedIds };
}

// `devin list` reports epoch seconds and the panel sorts and groups on that, so an
// ISO timestamp from the protocol has to arrive in the same units.
function epochSeconds(iso?: string): number | undefined {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

interface RunResult {
  ok: boolean;
  sessions: DevinSession[];
}

async function mapLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>, deadline: number): Promise<(R | undefined)[]> {
  const results = new Array<R | undefined>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && Date.now() < deadline) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function runList(cliPath: string, cwd: string, env?: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const cmd = cliCommand(cliPath, ["list", "--format", "json"]);
    execFile(
      cmd.file,
      cmd.args,
      { cwd, env, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: cmd.shell },
      (err, stdout) => {
        if (err && !stdout) {
          resolve({ ok: false, sessions: [] });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as DevinSession[];
          resolve({ ok: true, sessions: Array.isArray(parsed) ? parsed : [] });
        } catch {
          resolve({ ok: false, sessions: [] });
        }
      }
    );
  });
}
