/// <reference types="node" />
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const FILE_VERSION = 1;
const MAX_DEFAULT_LINES = 200;

export type PersistedUserFactsFile = {
  version: typeof FILE_VERSION;
  facts: string;
};

export function normalizeUserFactLineKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** 折叠后出现、但旧会话 facts 中没有的要点行（规范化去重） */
export function lineDeltaFromFacts(previous: string | undefined, next: string | undefined): string[] {
  const prevKeys = new Set(
    (previous ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map(normalizeUserFactLineKey),
  );
  const out: string[] = [];
  const seenOut = new Set(prevKeys);
  for (const line of (next ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const k = normalizeUserFactLineKey(t);
    if (seenOut.has(k)) continue;
    seenOut.add(k);
    out.push(t);
  }
  return out;
}

function defaultUserFactsPath(): string {
  const override = process.env.CHAT_USER_FACTS_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".chatbot-memory", "user-facts.json");
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

/**
 * 跨会话共享的用户级事实（偏好、稳定个人信息等），独立于各会话的 summary/facts。
 */
export class UserFactsStore {
  readonly filePath: string;
  private factsText = "";
  private saveChain: Promise<void> = Promise.resolve();
  private readonly maxLines: number;

  constructor(filePath: string, maxLines: number = MAX_DEFAULT_LINES) {
    this.filePath = filePath;
    this.maxLines = Math.max(10, maxLines);
  }

  static defaultPath(): string {
    return defaultUserFactsPath();
  }

  /** 纯文本，每行一条 */
  getFacts(): string {
    return this.factsText;
  }

  /** 整体替换并落盘 */
  setFacts(text: string): void {
    this.factsText = capLines(text.trim(), this.maxLines);
    void this.enqueueSave();
  }

  /**
   * 合并若干行：与已有事实按「整行规范化」去重，总量超过上限时保留末尾行。
   */
  mergeLines(lines: readonly string[]): void {
    if (lines.length === 0) return;
    const keys = new Set(
      this.factsText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map(normalizeUserFactLineKey),
    );
    const add: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      const k = normalizeUserFactLineKey(t);
      if (keys.has(k)) continue;
      keys.add(k);
      add.push(t);
    }
    if (add.length === 0) return;
    const merged = [this.factsText.trim(), ...add].filter(Boolean).join("\n");
    this.factsText = capLines(merged, this.maxLines);
    void this.enqueueSave();
  }

  clear(): void {
    this.factsText = "";
    void this.enqueueSave();
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedUserFactsFile;
      if (parsed.version !== FILE_VERSION || typeof parsed.facts !== "string") {
        console.warn("[UserFactsStore] 文件格式非预期，以空库开始");
        return;
      }
      this.factsText = capLines(parsed.facts.trim(), this.maxLines);
      console.log(`[UserFactsStore] 已加载用户级事实 (${this.filePath})`);
    } catch (e) {
      const code =
        e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string"
          ? (e as { code: string }).code
          : undefined;
      if (code === "ENOENT") {
        console.log(`[UserFactsStore] 无既有文件，将新建 (${this.filePath})`);
        return;
      }
      console.error("[UserFactsStore] 读取失败，以空库启动:", e);
    }
  }

  flushPending(): Promise<void> {
    return this.saveChain;
  }

  private enqueueSave(): void {
    this.saveChain = this.saveChain.then(() => this.flushToDisk());
  }

  private async flushToDisk(): Promise<void> {
    const payload: string = JSON.stringify(
      { version: FILE_VERSION, facts: this.factsText } satisfies PersistedUserFactsFile,
      null,
      0,
    );
    await atomicWriteFile(this.filePath, payload);
  }
}

function capLines(text: string, maxLines: number): string {
  const lines = text.split("\n").map((l) => l.trimEnd());
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length <= maxLines) return nonEmpty.join("\n");
  return nonEmpty.slice(-maxLines).join("\n");
}

export async function createUserFactsStore(
  filePath: string = UserFactsStore.defaultPath(),
  maxLines: number = MAX_DEFAULT_LINES,
): Promise<UserFactsStore> {
  const store = new UserFactsStore(filePath, maxLines);
  await store.load();
  return store;
}
