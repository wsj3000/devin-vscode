import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomUUID } from "crypto";

export const digest = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);
export const sessionIndex = (root: string, sessionId: string): string => path.join(root, `session-${digest(sessionId)}.json`);

export function privateDirectory(root: string): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("The Devin background directory must belong to this user and must not be a symlink.");
  }
  fs.chmodSync(root, 0o700);
}

export function readPrivate(file: string): any {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 4096) {
    throw new Error("Invalid Devin background metadata permissions.");
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function persistenceLocation(cwd: string, cli: string, sessionId?: string, base?: string): { root: string; key: string } {
  if (process.platform === "win32") throw new Error("Devin background sessions currently require Linux or macOS.");
  const root = path.join(base || path.join(os.homedir(), ".cache", "devin-vscode", "agents"), digest(`${cwd}\0${cli}`));
  privateDirectory(root);
  let key: string | undefined;
  if (sessionId) {
    try {
      const index = readPrivate(sessionIndex(root, sessionId));
      if (index.sessionId !== sessionId || !/^[a-f0-9-]{36}$/.test(index.key)) throw new Error("Invalid Devin background session index.");
      key = index.key;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return { root, key: key || randomUUID() };
}

export const agentSocket = (root: string, key: string): string => path.join(root, `${digest(key).slice(0, 16)}.sock`);
