import * as fs from "fs";
import * as path from "path";
import { ReadTextFileParams, WriteTextFileParams } from "./types";

export interface AgentFileEdit {
  full: string;
  original: string | null;
  content: string;
}

export async function readAgentFile(params: ReadTextFileParams, cwd: string): Promise<{ content: string }> {
  const full = path.resolve(cwd, params.path);
  let content = await fs.promises.readFile(full, "utf8");
  if (params.line || params.limit) {
    const lines = content.split("\n");
    const start = Math.max(0, (params.line ?? 1) - 1);
    content = lines.slice(start, params.limit ? start + params.limit : lines.length).join("\n");
  }
  return { content };
}

export async function writeAgentFile(params: WriteTextFileParams, cwd: string): Promise<AgentFileEdit> {
  const full = path.resolve(cwd, params.path);
  let bytes: Buffer | undefined;
  try {
    bytes = await fs.promises.readFile(full);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
  }
  const original = bytes ? bytes.toString("utf8") : null;
  if (bytes && original !== null && !bytes.equals(Buffer.from(original, "utf8"))) {
    throw new Error(`${path.basename(full)} is not UTF-8 text, so it was left alone.`);
  }
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  let content = original && /\r\n/.test(original) && !/\r\n/.test(params.content)
    ? params.content.replace(/\n/g, "\r\n") : params.content;
  if (original?.startsWith("\uFEFF") && !content.startsWith("\uFEFF")) content = "\uFEFF" + content;
  await fs.promises.writeFile(full, content, "utf8");
  return { full, original, content };
}
