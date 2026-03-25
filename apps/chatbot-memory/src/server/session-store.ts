/// <reference types="node" />
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ChatMessage } from "./chat-types.js";
import type { SessionMemory } from "./chat-types.js";

const FILE_VERSION = 1;

export type PersistedSessionBlob = {
  title: string;
  updatedAt: number;
  turns: ChatMessage[];
  summary?: string;
  facts?: string;
};

export type PersistedSessionsFile = {
  version: typeof FILE_VERSION;
  sessions: Record<string, PersistedSessionBlob>;
};

function truncateTitle(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function defaultStorePath(): string {
  const override = process.env.CHAT_SESSION_STORE_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".chatbot-memory", "sessions.json");
}

/** 将 SessionMemory 序列化为磁盘结构（不含 foldChain） */
function memoryToBlob(memory: SessionMemory, title: string, updatedAt: number): PersistedSessionBlob {
  return {
    title,
    updatedAt,
    turns: memory.turns,
    summary: memory.summary,
    facts: memory.facts,
  };
}

function blobToMemory(blob: PersistedSessionBlob): SessionMemory {
  return {
    turns: blob.turns ?? [],
    summary: blob.summary,
    facts: blob.facts,
  };
}

/**
 * 本地 JSON 文件持久化多会话；供 `createMemoryChatbot` 与 REST 共用。
 */
export class SessionStore {
  readonly filePath: string;
  private readonly memories = new Map<string, SessionMemory>();
  private readonly meta = new Map<string, { title: string; updatedAt: number }>();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  static defaultPath(): string {
    return defaultStorePath();
  }

  /** 从磁盘加载；文件不存在或损坏时以空库开始 */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedSessionsFile;
      if (parsed.version !== FILE_VERSION || !parsed.sessions || typeof parsed.sessions !== "object") {
        console.warn("[SessionStore] 文件格式非预期，忽略并从头开始");
        return;
      }
      for (const [id, blob] of Object.entries(parsed.sessions)) {
        if (!id || !blob || typeof blob !== "object") continue;
        const turns = Array.isArray(blob.turns) ? blob.turns : [];
        const mem = blobToMemory({ ...blob, turns });
        this.memories.set(id, mem);
        this.meta.set(id, {
          title: typeof blob.title === "string" && blob.title.trim() ? blob.title : "新会话",
          updatedAt: typeof blob.updatedAt === "number" ? blob.updatedAt : Date.now(),
        });
      }
      console.log(`[SessionStore] 已加载 ${this.memories.size} 个会话 (${this.filePath})`);
    } catch (e) {
      const code =
        e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string"
          ? (e as { code: string }).code
          : undefined;
      if (code === "ENOENT") {
        console.log(`[SessionStore] 无既有文件，将新建 (${this.filePath})`);
        return;
      }
      console.error("[SessionStore] 读取失败，以空库启动:", e);
    }
  }

  has(id: string): boolean {
    return this.memories.has(id);
  }

  getMemory(id: string): SessionMemory | undefined {
    return this.memories.get(id);
  }

  /** 取会话记忆；不存在则创建并落盘 */
  getOrCreateMemory(id: string): SessionMemory {
    let m = this.memories.get(id);
    if (!m) {
      m = { turns: [] };
      this.memories.set(id, m);
      this.meta.set(id, { title: "新会话", updatedAt: Date.now() });
      void this.enqueueSave();
    }
    return m;
  }

  /** 新建空会话，返回 id */
  createSession(): string {
    const id = randomUUID();
    this.memories.set(id, { turns: [] });
    this.meta.set(id, { title: "新会话", updatedAt: Date.now() });
    void this.enqueueSave();
    return id;
  }

  /** 仅清空轮次与分层记忆，保留会话条目与标题（用于「清空记忆」） */
  clearMemory(id: string): void {
    const m = this.memories.get(id);
    if (!m) return;
    m.turns = [];
    delete m.summary;
    delete m.facts;
    m.foldChain = undefined;
    const meta = this.meta.get(id);
    if (meta) meta.updatedAt = Date.now();
    void this.enqueueSave();
  }

  /** 删除整个会话 */
  deleteSession(id: string): boolean {
    const ok = this.memories.delete(id);
    this.meta.delete(id);
    if (ok) void this.enqueueSave();
    return ok;
  }

  clearAllSessions(): void {
    this.memories.clear();
    this.meta.clear();
    void this.enqueueSave();
  }

  setTitle(id: string, title: string): void {
    const meta = this.meta.get(id);
    if (!meta) return;
    meta.title = truncateTitle(title, 80) || "新会话";
    meta.updatedAt = Date.now();
    void this.enqueueSave();
  }

  /**
   * 一轮 user+assistant 已写入 memory 后调用：更新时间与首条标题。
   */
  onTurnCommitted(sessionId: string, userContent: string, wasEmptyBefore: boolean): void {
    const meta = this.meta.get(sessionId);
    if (!meta) return;
    meta.updatedAt = Date.now();
    if (wasEmptyBefore && meta.title === "新会话") {
      meta.title = truncateTitle(userContent, 48);
    }
    void this.enqueueSave();
  }

  /** 折叠摘要完成后再次落盘（summary/facts 已变） */
  onFoldSettled(sessionId: string): void {
    const meta = this.meta.get(sessionId);
    if (meta) meta.updatedAt = Date.now();
    void this.enqueueSave();
  }

  listSessions(): Array<{ id: string; title: string; updatedAt: number }> {
    const out: Array<{ id: string; title: string; updatedAt: number }> = [];
    for (const [id, m] of this.meta.entries()) {
      out.push({ id, title: m.title, updatedAt: m.updatedAt });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  getSessionPayload(id: string):
    | {
        id: string;
        title: string;
        updatedAt: number;
        turns: ChatMessage[];
        summary?: string;
        facts?: string;
      }
    | undefined {
    const memory = this.memories.get(id);
    const m = this.meta.get(id);
    if (!memory || !m) return undefined;
    return {
      id,
      title: m.title,
      updatedAt: m.updatedAt,
      turns: memory.turns,
      summary: memory.summary,
      facts: memory.facts,
    };
  }

  /** 等待队列中的写入完成（进程退出前可 await） */
  flushPending(): Promise<void> {
    return this.saveChain;
  }

  private enqueueSave(): void {
    this.saveChain = this.saveChain.then(() => this.flushToDisk());
  }

  private async flushToDisk(): Promise<void> {
    const sessions: Record<string, PersistedSessionBlob> = {};
    for (const [id, memory] of this.memories.entries()) {
      const m = this.meta.get(id);
      const title = m?.title ?? "新会话";
      const updatedAt = m?.updatedAt ?? Date.now();
      sessions[id] = memoryToBlob(memory, title, updatedAt);
    }
    const payload: PersistedSessionsFile = { version: FILE_VERSION, sessions };
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const json = JSON.stringify(payload, null, 0);
    await fs.writeFile(tmp, json, "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

export async function createSessionStore(
  filePath: string = SessionStore.defaultPath(),
): Promise<SessionStore> {
  const store = new SessionStore(filePath);
  await store.load();
  return store;
}
