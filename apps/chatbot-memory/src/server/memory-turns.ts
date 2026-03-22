import type { ChatMessage, SessionMemory } from "./chat-types.js";
import type { MemoryChatbotBehaviorConfig } from "./chat-env.js";

/** 统计多轮对话正文总字符数（用于是否超长裁切） */
export function totalTurnChars(turns: ChatMessage[]): number {
  return turns.reduce((s, m) => s + m.content.length, 0);
}

/** 将多轮消息格式化为「role: content」多行文本，供摘要/折叠提示词使用 */
export function formatTurnsForSummary(turns: ChatMessage[]): string {
  return turns.map((m) => `${m.role}: ${m.content}`).join("\n");
}

/**
 * 从 `turns` **队首**截下前 `nPairs` 轮（`2*nPairs` 条消息）并原地删除；
 * 长度不足时返回空数组且不修改原数组。
 */
export function takeFirstNPairsFromTurns(turns: ChatMessage[], nPairs: number): ChatMessage[] {
  const take = nPairs * 2;
  if (turns.length < take) return [];
  const dropped = turns.slice(0, take);
  turns.splice(0, take);
  return dropped;
}

/**
 * 增量摘要触发判断：当总轮数为 `incrementalEveryNPairs` 的整数倍且不少于 N 时，
 * 从队首移出连续 N 轮并返回（供与既有 summary/facts 融合）；否则返回空数组。
 */
export function popIncrementalSummaryBatch(
  session: SessionMemory,
  incrementalEveryNPairs: number,
): ChatMessage[] {
  const n = incrementalEveryNPairs;
  if (n <= 0) return [];
  const pairCount = session.turns.length / 2;
  if (!Number.isInteger(pairCount) || pairCount < n) return [];
  if (pairCount % n !== 0) return [];
  return takeFirstNPairsFromTurns(session.turns, n);
}

/**
 * 当轮数或总字符数超过上限时，从**最早**一对 user/assistant 开始逐轮丢弃，
 * 返回本轮被移出的消息列表（不调用模型）。
 */
export function trimTurnsIfOverLimit(
  session: SessionMemory,
  limits: Pick<MemoryChatbotBehaviorConfig, "maxHistoryPairs" | "maxHistoryChars">,
): ChatMessage[] {
  const { turns } = session;
  const dropped: ChatMessage[] = [];
  const { maxHistoryPairs, maxHistoryChars } = limits;

  while (turns.length >= 2) {
    const pairCount = turns.length / 2;
    const overPairs = maxHistoryPairs > 0 && pairCount > maxHistoryPairs;
    const overChars = maxHistoryChars > 0 && totalTurnChars(turns) > maxHistoryChars;
    if (!overPairs && !overChars) break;
    dropped.push(turns.shift()!, turns.shift()!);
  }

  return dropped;
}
