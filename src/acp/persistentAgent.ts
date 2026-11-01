import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { JsonRpcConnection } from "./connection";
import { TerminalManager } from "./terminal";
import { cliCommand } from "../cli/locate";
import { agentSocket, privateDirectory, sessionIndex } from "./persistentPaths";
import { readAgentFile, writeAgentFile } from "./agentFiles";

const MAX_HISTORY = 64 * 1024 * 1024;
const MAX_FRAME = 8 * 1024 * 1024;
const STATUS = "_devin.persist/status";
const STOP = "_devin.persist/stop";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Peer = { socket: net.Socket; ready: boolean };
type Callback = { method: string; params: any; resolve: (value: unknown) => void; reject: (error: Error) => void; peer?: Peer; id?: number };

class Agent {
  private child: ChildProcessWithoutNullStreams;
  private rpc: JsonRpcConnection;
  private terminals: TerminalManager;
  private owner?: Peer;
  private peers = new Set<Peer>();
  private callbacks = new Set<Callback>();
  private nextCallback = 1_000_000;
  private init?: Promise<any>;
  private initParams = "";
  private sessionId?: string;
  private opened?: any;
  private sessionParams?: any;
  private history: any[] = [];
  private historyBytes = 0;
  private overflow = false;
  private busy = false;
  private stopping = false;
  private terminalIds: string[] = [];

  constructor(private root: string, private key: string, private cli: string, private args: string[], private cwd: string) {
    const command = cliCommand(cli, ["acp", ...args]);
    this.child = spawn(command.file, command.args, {
      cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"], shell: command.shell,
      detached: process.platform !== "win32", windowsHide: true
    }) as ChildProcessWithoutNullStreams;
    this.terminals = new TerminalManager(process.env, cwd, (terminalId, output, exitStatus) => {
      this.publish("_devin.persist/terminalOutput", { sessionId: this.sessionId, terminalId, output, exitStatus });
    });
    this.rpc = new JsonRpcConnection(this.child,
      (method, params) => this.callback(method, params),
      (method, params) => this.publish(method, params));
    this.child.on("error", () => void this.shutdown());
    this.child.on("exit", () => void this.shutdown());
  }

  private send(peer: Peer, message: any): void {
    if (peer.socket.destroyed) return;
    if (peer.socket.writableLength > MAX_HISTORY + MAX_FRAME) {
      peer.socket.destroy();
      return;
    }
    peer.socket.write(JSON.stringify(message) + "\n");
  }

  private publish(method: string, params: any): void {
    const message = { jsonrpc: "2.0", method, params };
    if (method === "session/update" && params?.update?.sessionUpdate === "config_option_update" && this.opened) {
      this.opened.configOptions = params.update.configOptions;
    }
    if (method !== "_devin.persist/terminalOutput" && method !== "_devin.persist/turnEnded" && (this.sessionId || method === "session/update")) {
      const size = Buffer.byteLength(JSON.stringify(message));
      if (this.historyBytes + size <= MAX_HISTORY) {
        this.history.push(message);
        this.historyBytes += size;
      } else this.overflow = true;
    }
    if (this.owner?.ready) this.send(this.owner, message);
  }

  private dispatch(request: Callback): void {
    if (!this.owner?.ready || this.owner.socket.destroyed) return;
    request.peer = this.owner;
    request.id = ++this.nextCallback;
    this.send(this.owner, { jsonrpc: "2.0", id: request.id, method: request.method, params: request.params });
  }

  private async callback(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "terminal/create": {
        const result = this.terminals.create(params);
        this.terminalIds.push(result.terminalId);
        if (this.terminalIds.length > 50) this.terminalIds.shift();
        this.publish("_devin.persist/terminalCreated", { ...params, ...result });
        return result;
      }
      case "terminal/output": return this.terminals.output(params.terminalId);
      case "terminal/wait_for_exit": return this.terminals.waitForExit(params.terminalId);
      case "terminal/kill": this.terminals.kill(params.terminalId); return {};
      case "terminal/release": this.terminals.release(params.terminalId); return {};
      case "fs/read_text_file": return readAgentFile(params, this.cwd);
      case "fs/write_text_file": {
        const edit = await writeAgentFile(params, this.cwd);
        this.publish("_devin.persist/fileChanged", { sessionId: params.sessionId || this.sessionId, ...edit });
        return {};
      }
      case "_cognition.ai/request_diagnostics":
        if (!this.owner?.ready) return { items: [] };
        break;
    }
    return new Promise((resolve, reject) => {
      const request = { method, params, resolve, reject };
      this.callbacks.add(request);
      this.dispatch(request);
    });
  }

  private status(): any {
    return { pid: process.pid, agentPid: this.child.pid, sessionId: this.sessionId,
      busy: this.busy, runningTerminals: this.terminals.hasRunning(),
      pendingRequests: this.callbacks.size, cli: this.cli, cwd: this.cwd, args: this.args };
  }

  private snapshot(): any {
    return { ...this.opened, _meta: { ...this.opened?._meta, "devin.persist/busy": this.busy } };
  }

  private claim(peer: Peer): void {
    this.owner = peer;
    for (const request of this.callbacks) {
      request.peer = undefined;
      request.id = undefined;
    }
  }

  private async handle(peer: Peer, message: any): Promise<void> {
    const { id, method } = message;
    const params = message.params || {};
    const reply = (result: unknown) => id !== undefined && this.send(peer, { jsonrpc: "2.0", id, result });
    try {
      if (!method) {
        const request = [...this.callbacks].find((r) => r.peer === peer && r.id === id);
        if (request) {
          this.callbacks.delete(request);
          if (message.error) request.reject(new Error(message.error.message || "Client request failed"));
          else request.resolve(message.result);
        }
        return;
      }
      if (method === STATUS) { reply(this.status()); return; }
      if (method === STOP) {
        if (this.owner && this.owner !== peer) throw new Error("The session is controlled by another window.");
        reply({ stopped: true });
        setTimeout(() => void this.shutdown(), 25);
        return;
      }
      if (method === "initialize") {
        const fingerprint = JSON.stringify(params);
        if (this.init && fingerprint !== this.initParams) throw new Error("Devin background capabilities differ. Finish the old session before changing this setting.");
        if (!this.init) {
          this.initParams = fingerprint;
          this.init = this.rpc.request(method, params, 60_000).catch((error) => { this.init = undefined; throw error; });
        }
        const result = await this.init;
        peer.ready = true;
        reply(result);
        return;
      }
      if (!peer.ready) throw new Error("Devin background client is not initialized.");
      if (method === "session/load" && params.sessionId === this.sessionId) {
        if (params.cwd !== this.sessionParams?.cwd || JSON.stringify(params.mcpServers || []) !== JSON.stringify(this.sessionParams?.mcpServers || [])) {
          throw new Error("Reopen this background session in its original workspace with the same MCP configuration.");
        }
        if (this.overflow) throw new Error("Devin background transcript reached its memory limit. The task is still running.");
        this.claim(peer);
        for (const event of this.history) this.send(peer, event);
        for (const terminalId of this.terminalIds) {
          this.send(peer, { jsonrpc: "2.0", method: "_devin.persist/terminalOutput", params: {
            sessionId: this.sessionId, terminalId, ...this.terminals.output(terminalId)
          } });
        }
        reply(this.snapshot());
        for (const request of this.callbacks) this.dispatch(request);
        return;
      }
      if (this.owner && this.owner !== peer && method !== "session/list") {
        throw new Error("This session is controlled by another window. Reopen it to take control.");
      }
      if ((method === "session/new" || method === "session/load") && !this.sessionId) this.claim(peer);
      if (method === "_devin.persist/skipTerminal") { reply({ skipped: this.terminals.skip(params.terminalId) }); return; }
      if (method === "session/prompt") {
        if (this.busy) throw new Error("The original Devin turn is still running.");
        if (this.overflow) throw new Error("Devin background transcript reached its memory limit.");
        this.busy = true;
        for (const content of params.prompt || []) {
          // Saved for replay only. The live webview has already rendered its prompt.
          const size = Buffer.byteLength(JSON.stringify(content));
          if (this.historyBytes + size > MAX_HISTORY) { this.busy = false; throw new Error("Devin background transcript reached its memory limit."); }
          this.history.push({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: params.sessionId, update: { sessionUpdate: "user_message_chunk", content }
          } });
          this.historyBytes += size;
        }
      }
      if (id === undefined) { this.rpc.notify(method, params); return; }
      try {
        const result: any = await this.rpc.request(method, params,
          method === "session/prompt" ? undefined : method === "session/new" || method === "session/load" ? 180_000 : 30_000);
        if (method === "session/new" || method === "session/load") {
          this.sessionId = result.sessionId || params.sessionId;
          this.opened = result;
          this.sessionParams = params;
          this.claim(peer);
          const file = sessionIndex(this.root, this.sessionId!);
          const temp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(temp, JSON.stringify({ sessionId: this.sessionId, key: this.key }), { mode: 0o600 });
          fs.renameSync(temp, file);
        }
        if (method === "session/set_config_option" && this.opened && result?.configOptions) this.opened.configOptions = result.configOptions;
        reply(result);
        if (method === "session/prompt") this.publish("_devin.persist/turnEnded", { sessionId: this.sessionId, ...result });
      } catch (error) {
        if (method === "session/prompt") this.publish("_devin.persist/turnEnded", {
          sessionId: this.sessionId, stopReason: "cancelled", error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      } finally {
        if (method === "session/prompt") this.busy = false;
      }
    } catch (error) {
      if (id !== undefined) this.send(peer, { jsonrpc: "2.0", id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  accept(socket: net.Socket): void {
    const peer = { socket, ready: false };
    this.peers.add(peer);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > MAX_FRAME && !buffer.includes("\n")) { socket.destroy(); return; }
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > MAX_FRAME) { socket.destroy(); return; }
        try { void this.handle(peer, JSON.parse(line)); } catch { socket.destroy(); }
      }
    });
    const gone = () => {
      this.peers.delete(peer);
      if (this.owner === peer) this.owner = undefined;
      for (const request of this.callbacks) {
        if (request.peer !== peer) continue;
        request.peer = undefined; request.id = undefined;
        if (request.method === "_cognition.ai/request_diagnostics") {
          this.callbacks.delete(request); request.resolve({ items: [] });
        }
      }
    };
    socket.on("end", () => socket.end());
    socket.on("close", gone);
    socket.on("error", () => socket.destroy());
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.busy && this.sessionId) this.rpc.notify("session/cancel", { sessionId: this.sessionId });
    this.terminals.requestStopAll();
    this.rpc.dispose();
    await sleep(100);
    try { process.kill(-this.child.pid!, "SIGTERM"); } catch { /* already gone */ }
    await sleep(500);
    this.terminals.forceStopAll();
    try { process.kill(-this.child.pid!, "SIGKILL"); } catch { /* already gone */ }
    for (const peer of this.peers) peer.socket.destroy();
    process.exit(0);
  }
}

async function connect(file: string): Promise<net.Socket | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect(file);
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => { socket.destroy(); resolve(undefined); });
  });
}

async function daemon(root: string, key: string, cli: string, args: string[]): Promise<void> {
  privateDirectory(root);
  const lock = path.join(root, `${key}.lock`);
  try {
    const fd = fs.openSync(lock, "wx", 0o600);
    fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = fs.lstatSync(lock);
    if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error("Invalid Devin background lock.");
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (!Number.isInteger(pid) || pid <= 1) throw new Error("Invalid Devin background lock PID.");
    try { process.kill(pid, 0); return; } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; }
    fs.unlinkSync(lock);
    return daemon(root, key, cli, args);
  }
  const file = agentSocket(root, key);
  fs.rmSync(file, { force: true });
  const agent = new Agent(root, key, cli, args, process.cwd());
  const server = net.createServer((socket) => agent.accept(socket));
  process.on("exit", () => { fs.rmSync(file, { force: true }); fs.rmSync(lock, { force: true }); });
  process.on("SIGTERM", () => void agent.shutdown());
  process.on("SIGINT", () => void agent.shutdown());
  server.on("error", () => void agent.shutdown());
  server.listen(file, () => fs.chmodSync(file, 0o600));
}

async function proxy(root: string, key: string, cli: string, args: string[]): Promise<void> {
  process.stdin.pause();
  const file = agentSocket(root, key);
  let socket = await connect(file);
  if (!socket) {
    const child = spawn(process.execPath, [__filename, "daemon", root, key, cli, ...args], {
      cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, stdio: "ignore"
    });
    child.unref();
    for (let i = 0; i < 200 && !socket; i++) { await sleep(50); socket = await connect(file); }
  }
  if (!socket) throw new Error("Devin background agent did not start.");
  // Do not attach a different executable or working directory to a live agent.
  const check = socket;
  const response = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Devin background agent did not answer.")), 5000);
    let data = "";
    const onData = (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (!data.includes("\n")) return;
      clearTimeout(timer); check.off("data", onData);
      try { resolve(JSON.parse(data.slice(0, data.indexOf("\n")))); } catch (err) { reject(err); }
    };
    check.on("data", onData);
    check.write(JSON.stringify({ jsonrpc: "2.0", id: "hello", method: STATUS }) + "\n");
  });
  const result = response.result;
  if (!result || result.cwd !== process.cwd() || result.cli !== cli || JSON.stringify(result.args) !== JSON.stringify(args)) {
    check.destroy(); throw new Error("Devin background command differs. Finish its work before changing the CLI or arguments.");
  }
  socket.on("error", () => { process.exitCode = 1; process.stdin.destroy(); });
  socket.on("close", () => process.stdin.destroy());
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  process.stdin.resume();
}

const [mode, root, key, cli, ...args] = process.argv.slice(2);
if ((mode === "daemon" || mode === "proxy") && root && /^[a-f0-9-]{36}$/.test(key) && cli) {
  void (mode === "daemon" ? daemon(root, key, cli, args) : proxy(root, key, cli, args)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
