import { deflateRawSync, inflateRawSync } from "zlib";

export const HISTORY_LIMIT_BYTES = 256 * 1024 * 1024;

// Compress independent blocks so replay never inflates the whole conversation.
export class ReplayHistory {
  private blocks: Buffer[] = [];
  private tail: string[] = [];
  private tailBytes = 0;
  compressedBytes = 0;
  rawBytes = 0;
  events = 0;
  overflow = false;

  constructor(private readonly limit = HISTORY_LIMIT_BYTES) {}

  append(message: unknown): void {
    if (this.overflow) return;
    const frame = JSON.stringify(message) + "\n";
    this.tail.push(frame);
    const size = Buffer.byteLength(frame);
    this.tailBytes += size;
    this.rawBytes += size;
    this.events++;
    if (this.tailBytes >= 64 * 1024) this.flush();
  }

  private flush(): void {
    if (!this.tail.length) return;
    const block = deflateRawSync(this.tail.join(""), { level: 1 });
    this.tail = [];
    this.tailBytes = 0;
    if (this.compressedBytes + block.length > this.limit) {
      this.overflow = true;
      return;
    }
    this.blocks.push(block);
    this.compressedBytes += block.length;
  }

  snapshot(): Buffer[] {
    this.flush();
    return this.blocks.slice();
  }

  *frames(blocks: readonly Buffer[]): Generator<string> {
    for (const block of blocks) {
      const text = inflateRawSync(block).toString("utf8");
      for (const line of text.split("\n")) if (line) yield line + "\n";
    }
  }
}
