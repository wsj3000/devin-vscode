import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

export interface BackgroundAgentStatus {
  socket: string;
  sessionId: string;
  pid: number;
  agentPid: number;
  cli: string;
  cwd: string;
  busy: boolean;
  runningTerminals: boolean;
  pendingRequests: number;
  awaitingInput?: number;
}

async function privateEntry(file: string, socket = false): Promise<boolean> {
  const stat = await fs.promises.lstat(file);
  return (socket ? stat.isSocket() : stat.isDirectory()) &&
    (!process.getuid || stat.uid === process.getuid()) && (stat.mode & 0o077) === 0;
}

// A passive status request never initializes, loads or takes over a session.
async function backgroundRequest(file: string, stop?: BackgroundAgentStatus): Promise<BackgroundAgentStatus> {
  if (!await privateEntry(path.dirname(file)) || !await privateEntry(file, true)) throw new Error("Invalid Devin background socket permissions.");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    let buffer = "";
    let status: BackgroundAgentStatus | undefined;
    let stopped = false;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(status!);
    };
    const timer = setTimeout(() => finish(new Error("Devin background status did not answer.")), stop ? 2500 : 1000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_devin.persist/status" }) + "\n"));
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(stopped ? undefined : new Error("Devin background connection closed.")));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 64 * 1024) { finish(new Error("Invalid Devin background status size.")); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0 && !done) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.error) throw new Error(message.error.message || "Devin background request failed.");
          if (message.id === 2) { stopped = message.result?.stopped === true; continue; }
          if (message.id !== 1) continue;
          const value = message.result;
          if (!value || typeof value.sessionId !== "string" || !value.sessionId ||
            !Number.isInteger(value.pid) || value.pid <= 1 || !Number.isInteger(value.agentPid) || value.agentPid <= 1 ||
            typeof value.cli !== "string" || typeof value.cwd !== "string" || typeof value.busy !== "boolean" ||
            typeof value.runningTerminals !== "boolean" || !Number.isInteger(value.pendingRequests) || value.pendingRequests < 0) {
            throw new Error("Invalid Devin background status.");
          }
          process.kill(value.pid, 0);
          process.kill(value.agentPid, 0);
          status = { socket: file, sessionId: value.sessionId, pid: value.pid, agentPid: value.agentPid,
            cli: value.cli, cwd: value.cwd, busy: value.busy, runningTerminals: value.runningTerminals,
            pendingRequests: value.pendingRequests, awaitingInput: Number.isInteger(value.awaitingInput) && value.awaitingInput >= 0 ? value.awaitingInput : undefined };
          if (!stop) { finish(); return; }
          if (stop.pid !== status.pid || stop.agentPid !== status.agentPid || stop.sessionId !== status.sessionId) {
            throw new Error("This background session changed while confirming termination. Refresh the session list.");
          }
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "_devin.persist/stop" }) + "\n");
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }
    });
  });
}

export function readBackgroundAgent(file: string): Promise<BackgroundAgentStatus> {
  return backgroundRequest(file);
}

export async function stopBackgroundAgent(status: BackgroundAgentStatus): Promise<void> {
  await backgroundRequest(status.socket, status);
}

export async function scanBackgroundAgents(base = path.join(os.homedir(), ".cache", "devin-vscode", "agents")): Promise<BackgroundAgentStatus[]> {
  if (process.platform === "win32") return [];
  const files: string[] = [];
  try {
    for (const dir of await fs.promises.readdir(base)) {
      if (!/^[a-f0-9]{24}$/.test(dir)) continue;
      const root = path.join(base, dir);
      try {
        if (!await privateEntry(root)) continue;
        for (const file of await fs.promises.readdir(root)) {
          if (/^[a-f0-9]{16}\.sock$/.test(file)) files.push(path.join(root, file));
        }
      } catch { /* stale or inaccessible directory */ }
    }
  } catch { return []; }
  const statuses: BackgroundAgentStatus[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (next < files.length) {
      const file = files[next++];
      try { statuses.push(await readBackgroundAgent(file)); } catch { /* stale or unreachable broker */ }
    }
  }));
  return statuses;
}
