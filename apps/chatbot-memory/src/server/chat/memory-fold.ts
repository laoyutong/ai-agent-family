import type { ChatMessage, SessionMemory } from "./chat-types.js";
import type { CompleteNonStreaming } from "../llm/deepseek-client.js";
import { formatTurnsForSummary } from "./memory-turns.js";

/** 解析记忆分层模型返回的 JSON（可带 markdown 围栏），提取 summary / facts 字段 */
function parseLayeredFoldOutput(text: string): { summary: string; facts: string } {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/m);
  const jsonStr = (fenced ? fenced[1] : trimmed).trim();
  const parsed = JSON.parse(jsonStr) as { summary?: unknown; facts?: unknown };
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const facts = typeof parsed.facts === "string" ? parsed.facts.trim() : "";
  return { summary, facts };
}

/**
 * 基于非流式 API 构造「折叠」能力：将移出对话与既有摘要/要点合并为新的分层记忆。
 * 返回的 `foldDroppedIntoLayers` 为主入口；内部含 JSON 失败时的单段摘要降级。
 */
export function createMemoryFold(completeNonStreaming: CompleteNonStreaming) {
  /** 降级：仅生成一段合并摘要，不输出 facts 结构 */
  async function foldDroppedIntoSummary(
    previousSummary: string | undefined,
    dropped: ChatMessage[],
  ): Promise<string> {
    const body = [
      previousSummary?.trim() ? `既有摘要：\n${previousSummary.trim()}\n\n` : "",
      `待合并对话：\n${formatTurnsForSummary(dropped)}`,
    ].join("");
    return completeNonStreaming([
      {
        role: "system",
        content:
          "你是对话摘要助手。将「既有摘要」（若有）与「待合并对话」合并为极简中文要点：只写结论、决定与不可替代的专名/数字，不写过程与寒暄，不逐句复述。合并去重后**总长不超过约 300 字**（宁短勿长）。摘要用于与本地保存的「原文归档」索引对照，须保留可追溯的**主题/结论短语**（无需标注序号）。",
      },
      { role: "user", content: body },
    ]);
  }

  /** 主路径：一次请求输出 JSON，更新叙事摘要（summary）与长期要点（facts） */
  async function foldDroppedIntoLayers(
    previousSummary: string | undefined,
    previousFacts: string | undefined,
    dropped: ChatMessage[],
  ): Promise<{ summary: string; facts: string }> {
    const userParts: string[] = [];
    if (previousSummary?.trim()) userParts.push(`既有会话摘要：\n${previousSummary.trim()}`);
    if (previousFacts?.trim()) userParts.push(`既有长期要点：\n${previousFacts.trim()}`);
    userParts.push(`待合并对话：\n${formatTurnsForSummary(dropped)}`);
    const userContent = userParts.join("\n\n");

    const raw = await completeNonStreaming([
      {
        role: "system",
        content:
          "你是记忆分层助手。根据「既有会话摘要」「既有长期要点」（可无）与「待合并对话」，输出**仅**一个 JSON 对象，键为 summary 与 facts，不要 markdown 代码块或其它说明文字。\n" +
            "summary：用一两段极短中文概括**仍对后续对话有用**的脉络（话题+结论/立场），不写细节与铺垫；与既有摘要合并去重后**总长不超过约 300 字**。summary 会与本地「原文轮次归档」并存，请用**可区分话题的短标签式表述**便于按主题回看原文。\n" +
            "facts：每行一条，仅用户偏好、硬事实、约定、专名与关键数字；合并既有长期要点并去重，**不超过 20 行**，能合并成一条的不要拆成多条。",
      },
      { role: "user", content: userContent },
    ]);

    try {
      const { summary, facts } = parseLayeredFoldOutput(raw);
      if (!summary && !facts) {
        throw new Error("layered fold empty");
      }
      return {
        summary: summary || (previousSummary?.trim() ?? ""),
        facts: facts || (previousFacts?.trim() ?? ""),
      };
    } catch {
      const summaryOnly = await foldDroppedIntoSummary(previousSummary, dropped);
      return {
        summary: summaryOnly,
        facts: previousFacts?.trim() ?? "",
      };
    }
  }

  return { foldDroppedIntoLayers };
}

export type FoldArchiveEnqueueRef = {
  index: number;
  createdAt: number;
};

/**
 * 生成「异步排队折叠」函数：把移出的对话串到 `session.foldChain` 上，避免并发写 summary/facts。
 * - `incremental`：定时增量摘要，总是尝试折叠；
 * - `trim`：超长裁切移出，仅当 `summarizeOnTrim` 为 true 时才折叠。
 */
export function createEnqueueFold(
  foldDroppedIntoLayers: ReturnType<typeof createMemoryFold>["foldDroppedIntoLayers"],
  summarizeOnTrim: boolean,
  options?: {
    /** 单次折叠 promise 结束后调用（如写入会话持久化） */
    onFoldSettled?: (sessionId: string) => void;
    /**
     * 在调用模型折叠之前：原始被移出轮次已可安全落盘（与 summary 解耦，供索引检索）。
     * 返回 `{ index, createdAt }` 时，折叠成功后触发 `onFoldArchiveFinalized`。
     */
    onArchiveDropped?: (params: {
      sessionId: string;
      mode: "incremental" | "trim";
      dropped: ChatMessage[];
    }) => void | Promise<void | FoldArchiveEnqueueRef | null | undefined>;
    /**
     * `onArchiveDropped` 已落盘且本轮模型折叠成功、`session.summary` / `facts` 已更新后调用（如回填归档、写入 `foldArchiveLinks`）。
     */
    onFoldArchiveFinalized?: (params: {
      sessionId: string;
      mode: "incremental" | "trim";
      ref: FoldArchiveEnqueueRef;
      session: SessionMemory;
      previousSummary: string | undefined;
      previousFacts: string | undefined;
    }) => void | Promise<void>;
    /**
     * 折叠成功并写回 `session.summary` / `session.facts` 之后调用（如同步到用户级事实库）。
     * `previousSummary` / `previousFacts` 为折叠前的会话层快照。
     */
    onAfterFold?: (params: {
      sessionId?: string;
      session: SessionMemory;
      previousSummary: string | undefined;
      previousFacts: string | undefined;
    }) => void | Promise<void>;
  },
): (
  session: SessionMemory,
  dropped: ChatMessage[],
  mode: "incremental" | "trim",
  sessionId?: string,
) => void {
  /** 将 `dropped` 异步合并进会话的 summary/facts（不阻塞调用方） */
  return function enqueueFold(
    session: SessionMemory,
    dropped: ChatMessage[],
    mode: "incremental" | "trim",
    sessionId?: string,
  ): void {
    if (dropped.length === 0) return;
    if (mode === "trim" && !summarizeOnTrim) return;

    session.foldChain = (session.foldChain ?? Promise.resolve())
      .then(async () => {
        const sid = sessionId ?? "";
        let archiveRef: FoldArchiveEnqueueRef | undefined;
        if (sid) {
          try {
            const r = await options?.onArchiveDropped?.({ sessionId: sid, mode, dropped });
            if (r && typeof r.index === "number" && r.index >= 1 && typeof r.createdAt === "number") {
              archiveRef = { index: r.index, createdAt: r.createdAt };
            }
          } catch (archErr) {
            console.error("[memory-fold] onArchiveDropped 失败:", archErr);
          }
        }
        const previousSummary = session.summary;
        const previousFacts = session.facts;
        try {
          const { summary, facts } = await foldDroppedIntoLayers(
            session.summary,
            session.facts,
            dropped,
          );
          session.summary = summary.trim() || undefined;
          session.facts = facts.trim() || undefined;
          if (archiveRef && sid) {
            try {
              await options?.onFoldArchiveFinalized?.({
                sessionId: sid,
                mode,
                ref: archiveRef,
                session,
                previousSummary,
                previousFacts,
              });
            } catch (linkErr) {
              console.error("[memory-fold] onFoldArchiveFinalized 失败:", linkErr);
            }
          }
          try {
            await options?.onAfterFold?.({
              sessionId,
              session,
              previousSummary,
              previousFacts,
            });
          } catch (hookErr) {
            console.error("[memory-fold] onAfterFold 失败:", hookErr);
          }
        } catch (e) {
          console.error(
            mode === "incremental" ? "incremental summary fold failed:" : "chat history summarize failed:",
            e,
          );
        }
      })
      .finally(() => {
        if (sessionId) options?.onFoldSettled?.(sessionId);
      });
  };
}
