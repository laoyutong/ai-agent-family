/// <reference types="node" />
import { mkdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { ChatMessage } from "../chat/chat-types.js";

const INDEX_FILE = "_index.json";

export type FoldArchiveMode = "incremental" | "trim";

/** `append` 成功后的批次句柄，用于与会话 `foldArchiveLinks` 及折叠后写回对齐 */
export type FoldArchiveBatchRef = {
  index: number;
  createdAt: number;
};

/** 列表/索引中一条（不含完整 turns，用于浏览） */
export type FoldArchiveListItem = {
  index: number;
  mode: FoldArchiveMode;
  createdAt: number;
  pairCount: number;
  charCount: number;
  /** 首条 user 内容前几字，便于检索 */
  previewUser: string;
  /** 折叠前会话层摘要前几字（强关联预览，仅在新归档写入） */
  summaryBeforePreview?: string;
};

type IndexFileShape = {
  version: 1;
  entries: FoldArchiveListItem[];
};

/** 单条归档全文（含被摘要前的原始轮次 + 与 summary/facts 的强关联字段） */
export type FoldArchiveRecord = FoldArchiveListItem & {
  sessionId: string;
  turns: ChatMessage[];
  /** 写入归档时会话上的 summary（折叠前） */
  summaryBefore?: string;
  factsBefore?: string;
  /** 折叠成功后回写：本轮合并后的会话层 */
  summaryAfter?: string;
  factsAfter?: string;
};

function archiveSessionDir(baseDir: string, sessionId: string): string {
  return path.join(baseDir, sessionId.replace(/[/\\]/g, "_"));
}

function previewFromTurns(turns: ChatMessage[]): string {
  const firstUser = turns.find((m) => m.role === "user");
  const raw = firstUser?.content?.trim() ?? "";
  return raw.length <= 120 ? raw : `${raw.slice(0, 117)}…`;
}

function charCountTurns(turns: ChatMessage[]): number {
  return turns.reduce((n, m) => n + (m.content?.length ?? 0), 0);
}

function previewSummary(s: string | undefined): string | undefined {
  const t = s?.trim();
  if (!t) return undefined;
  return t.length <= 120 ? t : `${t.slice(0, 117)}…`;
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

/** 根据会话库路径推导默认归档根目录（与 sessions 同级 `fold-archives`） */
export function resolveFoldArchiveBaseDir(store: { filePath: string; mode: "sharded" | "legacy" }): string {
  const override = process.env.CHAT_FOLD_ARCHIVE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(path.dirname(store.filePath), "fold-archives");
}

/**
 * 折叠前被移出上下文的原文归档：按 session 分子目录，每条一个 JSON，
 * `_index.json` 维护时间序索引（仅元数据），便于按序号拉取全文。
 */
export class FoldArchiveStore {
  constructor(readonly baseDir: string) {}

  /**
   * 在调用折叠模型前落盘原文；可选传入折叠前的 summary/facts 以便与折叠结果强关联。
   */
  async append(
    sessionId: string,
    mode: FoldArchiveMode,
    turns: ChatMessage[],
    layerBefore?: { summaryBefore?: string; factsBefore?: string },
  ): Promise<FoldArchiveBatchRef | null> {
    if (turns.length === 0) return null;
    const dir = archiveSessionDir(this.baseDir, sessionId);
    await fs.mkdir(dir, { recursive: true });

    const indexPath = path.join(dir, INDEX_FILE);
    let indexDoc: IndexFileShape = { version: 1, entries: [] };
    try {
      const raw = await fs.readFile(indexPath, "utf8");
      const parsed = JSON.parse(raw) as IndexFileShape;
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
        indexDoc = parsed;
      }
    } catch {
      /* 无索引则新建 */
    }

    const nextIndex =
      indexDoc.entries.length === 0
        ? 1
        : Math.max(...indexDoc.entries.map((e) => e.index)) + 1;

    const createdAt = Date.now();
    const pairCount = Math.floor(turns.length / 2);
    const charCount = charCountTurns(turns);
    const previewUser = previewFromTurns(turns);
    const sb = layerBefore?.summaryBefore?.trim();
    const fb = layerBefore?.factsBefore?.trim();
    const summaryBeforePreview = previewSummary(sb);

    const meta: FoldArchiveListItem = {
      index: nextIndex,
      mode,
      createdAt,
      pairCount,
      charCount,
      previewUser,
      ...(summaryBeforePreview !== undefined ? { summaryBeforePreview } : {}),
    };

    const full: FoldArchiveRecord = {
      ...meta,
      sessionId,
      turns,
      ...(sb ? { summaryBefore: sb } : {}),
      ...(fb ? { factsBefore: fb } : {}),
    };

    const recordPath = path.join(dir, `${nextIndex}.json`);
    await atomicWriteFile(recordPath, JSON.stringify(full, null, 0));

    indexDoc.entries.push(meta);
    indexDoc.entries.sort((a, b) => a.index - b.index);
    await atomicWriteFile(indexPath, JSON.stringify(indexDoc, null, 0));

    return { index: nextIndex, createdAt };
  }

  /** 折叠成功并写回会话后调用：把本轮合并后的 summary/facts 写入对应归档 JSON */
  async finalizeEntry(
    sessionId: string,
    index: number,
    layerAfter: { summaryAfter?: string; factsAfter?: string },
  ): Promise<void> {
    if (!Number.isFinite(index) || index < 1) return;
    const recordPath = path.join(archiveSessionDir(this.baseDir, sessionId), `${Math.floor(index)}.json`);
    let raw: string;
    try {
      raw = await fs.readFile(recordPath, "utf8");
    } catch {
      return;
    }
    let rec: FoldArchiveRecord;
    try {
      rec = JSON.parse(raw) as FoldArchiveRecord;
      if (!rec || typeof rec !== "object" || !Array.isArray(rec.turns)) return;
    } catch {
      return;
    }
    const next: FoldArchiveRecord = {
      ...rec,
      summaryAfter: layerAfter.summaryAfter?.trim() || undefined,
      factsAfter: layerAfter.factsAfter?.trim() || undefined,
    };
    await atomicWriteFile(recordPath, JSON.stringify(next, null, 0));
  }

  async list(sessionId: string): Promise<FoldArchiveListItem[]> {
    const indexPath = path.join(archiveSessionDir(this.baseDir, sessionId), INDEX_FILE);
    try {
      const raw = await fs.readFile(indexPath, "utf8");
      const parsed = JSON.parse(raw) as IndexFileShape;
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
        return [...parsed.entries].sort((a, b) => a.index - b.index);
      }
    } catch {
      /* */
    }
    return [];
  }

  async get(sessionId: string, index: number): Promise<FoldArchiveRecord | null> {
    if (!Number.isFinite(index) || index < 1) return null;
    const recordPath = path.join(archiveSessionDir(this.baseDir, sessionId), `${Math.floor(index)}.json`);
    try {
      const raw = await fs.readFile(recordPath, "utf8");
      const rec = JSON.parse(raw) as FoldArchiveRecord;
      if (!rec || typeof rec !== "object" || !Array.isArray(rec.turns)) return null;
      return rec;
    } catch {
      return null;
    }
  }

  /** 删除该会话全部归档（与 `deleteSession` 同步调用） */
  removeSessionArchivesSync(sessionId: string): void {
    const dir = archiveSessionDir(this.baseDir, sessionId);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }

  /** 异步等价，供仅需非阻塞刷盘的路径使用 */
  async removeSessionArchives(sessionId: string): Promise<void> {
    this.removeSessionArchivesSync(sessionId);
  }

  /** 清空全部会话的归档目录（与 `clearAllSessions` 同步） */
  clearAllSync(): void {
    try {
      rmSync(this.baseDir, { recursive: true, force: true });
    } catch {
      /* */
    }
    try {
      mkdirSync(this.baseDir, { recursive: true });
    } catch {
      /* */
    }
  }
}

export function parseFoldArchiveEnabled(): boolean {
  const v = process.env.CHAT_FOLD_ARCHIVE_ENABLE?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no") return false;
  return true;
}
