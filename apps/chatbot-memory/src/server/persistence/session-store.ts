/// <reference types="node" />
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ChatMessage, SessionMemory } from "../chat/chat-types.js";

const FILE_VERSION = 1;
const MANIFEST_NAME = "manifest.json";

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

type SessionManifest = {
  version: typeof FILE_VERSION;
  sessions: Record<string, { title: string; updatedAt: number }>;
};

function normalizeTitle(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function defaultLegacySessionsFile(): string {
  return path.join(os.homedir(), ".chatbot-memory", "sessions.json");
}

function defaultShardedSessionsDir(): string {
  return path.join(os.homedir(), ".chatbot-memory", "sessions");
}

/** 未设置环境变量时：使用按会话分文件的目录存储 */
function defaultStorePath(): string {
  const override = process.env.CHAT_SESSION_STORE_PATH?.trim();
  if (override) return path.resolve(override);
  return defaultShardedSessionsDir();
}

/**
 * 若 `CHAT_SESSION_STORE_PATH` 以 `.json` 结尾，视为旧版单文件库路径；
 * 否则视为目录路径（每会话一个 JSON + manifest）。
 */
export function resolveSessionStorePath(): { mode: "sharded" | "legacy"; path: string } {
  const override = process.env.CHAT_SESSION_STORE_PATH?.trim();
  if (!override) {
    return { mode: "sharded", path: defaultShardedSessionsDir() };
  }
  const resolved = path.resolve(override);
  if (resolved.toLowerCase().endsWith(".json")) {
    return { mode: "legacy", path: resolved };
  }
  return { mode: "sharded", path: resolved };
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

/** 将默认位置的旧单文件库迁移到分文件目录（仅执行一次） */
async function migrateDefaultLegacyFileToShardedDir(dirPath: string): Promise<void> {
  if (path.resolve(dirPath) !== path.resolve(defaultShardedSessionsDir())) {
    return;
  }
  const legacyPath = defaultLegacySessionsFile();
  const manifestPath = path.join(dirPath, MANIFEST_NAME);
  try {
    await fs.access(manifestPath);
    return;
  } catch {
    /* 无 manifest 则尝试迁移 */
  }
  let legacyRaw: string;
  try {
    legacyRaw = await fs.readFile(legacyPath, "utf8");
  } catch {
    return;
  }
  let parsed: PersistedSessionsFile;
  try {
    parsed = JSON.parse(legacyRaw) as PersistedSessionsFile;
  } catch {
    console.warn("[SessionStore] 旧 sessions.json 无法解析，跳过迁移");
    return;
  }
  if (parsed.version !== FILE_VERSION || !parsed.sessions || typeof parsed.sessions !== "object") {
    console.warn("[SessionStore] 旧 sessions.json 格式非预期，跳过迁移");
    return;
  }
  await fs.mkdir(dirPath, { recursive: true });
  const sessions: SessionManifest["sessions"] = {};
  for (const [id, blob] of Object.entries(parsed.sessions)) {
    if (!id || !blob || typeof blob !== "object") continue;
    const turns = Array.isArray(blob.turns) ? blob.turns : [];
    const normalized: PersistedSessionBlob = {
      ...blob,
      turns,
      title: typeof blob.title === "string" && blob.title.trim() ? blob.title : "新会话",
      updatedAt: typeof blob.updatedAt === "number" ? blob.updatedAt : Date.now(),
    };
    sessions[id] = { title: normalized.title, updatedAt: normalized.updatedAt };
    await atomicWriteFile(path.join(dirPath, `${id}.json`), JSON.stringify(normalized));
  }
  const manifest: SessionManifest = { version: FILE_VERSION, sessions };
  await atomicWriteFile(path.join(dirPath, MANIFEST_NAME), JSON.stringify(manifest));
  try {
    await fs.rename(legacyPath, `${legacyPath}.migrated`);
    console.log(`[SessionStore] 已从单文件迁移至目录存储，原文件已重命名为 ${legacyPath}.migrated`);
  } catch (e) {
    console.warn("[SessionStore] 迁移后无法重命名旧文件（可手动删除）:", e);
  }
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
 * 本地持久化多会话：默认按会话分文件（仅写变更会话），单文件模式仍可通过 `.json` 路径使用。
 */
export class SessionStore {
  /** 分文件模式下为目录；单文件模式下为 `*.json` 路径 */
  readonly filePath: string;
  readonly mode: "sharded" | "legacy";

  private readonly memories = new Map<string, SessionMemory>();
  private readonly meta = new Map<string, { title: string; updatedAt: number }>();
  private saveChain: Promise<void> = Promise.resolve();

  private dirtyIds = new Set<string>();
  private pendingDeletes = new Set<string>();
  private pendingClearAll = false;

  constructor(options: { mode: "sharded" | "legacy"; path: string }) {
    this.mode = options.mode;
    this.filePath = options.path;
  }

  static defaultPath(): string {
    return defaultStorePath();
  }

  /** 从磁盘加载；文件不存在或损坏时以空库开始 */
  async load(): Promise<void> {
    if (this.mode === "legacy") {
      await this.loadLegacy();
    } else {
      await this.loadSharded();
    }
  }

  private async loadLegacy(): Promise<void> {
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
      console.log(`[SessionStore] 已加载 ${this.memories.size} 个会话 (单文件 ${this.filePath})`);
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

  private async loadSharded(): Promise<void> {
    await fs.mkdir(this.filePath, { recursive: true });
    await migrateDefaultLegacyFileToShardedDir(this.filePath);

    const manifestPath = path.join(this.filePath, MANIFEST_NAME);
    let manifest: SessionManifest | null = null;
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as SessionManifest;
      if (parsed.version === FILE_VERSION && parsed.sessions && typeof parsed.sessions === "object") {
        manifest = parsed;
      }
    } catch {
      /* 无 manifest 或损坏时尝试按文件名恢复 */
    }

    let ids: string[];
    if (manifest) {
      ids = Object.keys(manifest.sessions);
    } else {
      let entries: string[] = [];
      try {
        entries = await fs.readdir(this.filePath);
      } catch {
        entries = [];
      }
      ids = entries
        .filter((n) => n.endsWith(".json") && n !== MANIFEST_NAME)
        .map((n) => n.slice(0, -".json".length));
    }

    for (const id of ids) {
      const filePath = path.join(this.filePath, `${id}.json`);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }
      let blob: PersistedSessionBlob;
      try {
        blob = JSON.parse(raw) as PersistedSessionBlob;
      } catch {
        console.warn(`[SessionStore] 跳过损坏的会话文件: ${id}.json`);
        continue;
      }
      if (!blob || typeof blob !== "object") continue;
      const turns = Array.isArray(blob.turns) ? blob.turns : [];
      const mem = blobToMemory({ ...blob, turns });
      this.memories.set(id, mem);
      const fromManifest = manifest?.sessions?.[id];
      const title =
        typeof blob.title === "string" && blob.title.trim()
          ? blob.title
          : (fromManifest?.title ?? "新会话");
      const updatedAt =
        typeof blob.updatedAt === "number"
          ? blob.updatedAt
          : (fromManifest?.updatedAt ?? Date.now());
      this.meta.set(id, { title, updatedAt });
    }
    console.log(`[SessionStore] 已加载 ${this.memories.size} 个会话 (目录 ${this.filePath})`);
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
      this.markDirty(id);
      void this.enqueueSave();
    }
    return m;
  }

  /** 新建空会话，返回 id */
  createSession(): string {
    const id = randomUUID();
    this.memories.set(id, { turns: [] });
    this.meta.set(id, { title: "新会话", updatedAt: Date.now() });
    this.markDirty(id);
    void this.enqueueSave();
    return id;
  }

  /** 仅清空轮次与分层记忆，保留会话 id；标题恢复为「新会话」（用于「清空记忆」） */
  clearMemory(id: string): void {
    const m = this.memories.get(id);
    if (!m) return;
    m.turns = [];
    delete m.summary;
    delete m.facts;
    m.foldChain = undefined;
    const meta = this.meta.get(id);
    if (meta) {
      meta.title = "新会话";
      meta.updatedAt = Date.now();
    }
    this.markDirty(id);
    void this.enqueueSave();
  }

  /** 删除整个会话 */
  deleteSession(id: string): boolean {
    const ok = this.memories.delete(id);
    this.meta.delete(id);
    if (ok) {
      if (this.mode === "sharded") {
        this.pendingDeletes.add(id);
        this.dirtyIds.delete(id);
      }
      void this.enqueueSave();
    }
    return ok;
  }

  clearAllSessions(): void {
    this.memories.clear();
    this.meta.clear();
    this.dirtyIds.clear();
    this.pendingDeletes.clear();
    if (this.mode === "sharded") {
      this.pendingClearAll = true;
    }
    void this.enqueueSave();
  }

  setTitle(id: string, title: string): void {
    const meta = this.meta.get(id);
    if (!meta) return;
    meta.title = normalizeTitle(title) || "新会话";
    meta.updatedAt = Date.now();
    this.markDirty(id);
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
      meta.title = normalizeTitle(userContent);
    }
    this.markDirty(sessionId);
    void this.enqueueSave();
  }

  /** 折叠摘要完成后再次落盘（summary/facts 已变） */
  onFoldSettled(sessionId: string): void {
    const meta = this.meta.get(sessionId);
    if (meta) meta.updatedAt = Date.now();
    this.markDirty(sessionId);
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

  private markDirty(id: string): void {
    if (this.mode === "sharded") {
      this.dirtyIds.add(id);
    }
  }

  private enqueueSave(): void {
    this.saveChain = this.saveChain.then(() => this.flushToDisk());
  }

  private async flushToDisk(): Promise<void> {
    if (this.mode === "legacy") {
      await this.flushLegacy();
      return;
    }
    await this.flushSharded();
  }

  private async flushLegacy(): Promise<void> {
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
    const json = JSON.stringify(payload, null, 0);
    await atomicWriteFile(this.filePath, json);
  }

  private async flushSharded(): Promise<void> {
    await fs.mkdir(this.filePath, { recursive: true });

    if (this.pendingClearAll) {
      await this.removeAllSessionFilesInDir();
      this.pendingClearAll = false;
      this.pendingDeletes.clear();
      this.dirtyIds.clear();
      await this.writeManifestFile();
      return;
    }

    for (const id of this.pendingDeletes) {
      try {
        await fs.unlink(path.join(this.filePath, `${id}.json`));
      } catch {
        /* 已不存在 */
      }
    }
    this.pendingDeletes.clear();

    for (const id of this.dirtyIds) {
      const mem = this.memories.get(id);
      const m = this.meta.get(id);
      if (!mem || !m) continue;
      const blob = memoryToBlob(mem, m.title, m.updatedAt);
      await atomicWriteFile(path.join(this.filePath, `${id}.json`), JSON.stringify(blob));
    }
    this.dirtyIds.clear();

    await this.writeManifestFile();
  }

  private async removeAllSessionFilesInDir(): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.filePath);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(".json") || name === MANIFEST_NAME) continue;
      await fs.unlink(path.join(this.filePath, name)).catch(() => {});
    }
  }

  private async writeManifestFile(): Promise<void> {
    const sessions: SessionManifest["sessions"] = {};
    for (const [id, m] of this.meta.entries()) {
      sessions[id] = { title: m.title, updatedAt: m.updatedAt };
    }
    const manifest: SessionManifest = { version: FILE_VERSION, sessions };
    await atomicWriteFile(path.join(this.filePath, MANIFEST_NAME), JSON.stringify(manifest));
  }
}

export async function createSessionStore(
  filePath?: string,
  options?: { mode?: "sharded" | "legacy" },
): Promise<SessionStore> {
  const resolved =
    filePath !== undefined
      ? {
          mode: options?.mode ?? (filePath.toLowerCase().endsWith(".json") ? "legacy" : "sharded"),
          path: path.resolve(filePath),
        }
      : resolveSessionStorePath();
  const store = new SessionStore(resolved);
  await store.load();
  return store;
}
