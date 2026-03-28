import type { CompleteNonStreaming } from "../llm/deepseek-client.js";
import type { SessionMemory } from "./chat-types.js";
import { lineDeltaFromFacts } from "../persistence/user-facts-store.js";
import type { UserFactsStore } from "../persistence/user-facts-store.js";

/**
 * 从会话折叠新增的 facts 行中，筛出适合写入**所有会话**的长期条目（可选 LLM，失败则回退为直接使用增量行）。
 */
async function extractCrossSessionLinesWithLlm(
  deltaLines: string[],
  existingUserFacts: string,
  complete: CompleteNonStreaming,
  model: string,
): Promise<string[]> {
  if (deltaLines.length === 0) return [];
  const body = [
    existingUserFacts.trim() ? `已有用户级要点：\n${existingUserFacts.trim()}\n` : "",
    `本轮从会话中新沉淀的候选要点（每行一条）：\n${deltaLines.join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await complete(
    [
      {
        role: "system",
        content:
          "你是用户画像助手。从「候选要点」中仅选出适合写入**跨所有聊天会话**长期记忆的内容：稳定偏好、称谓/姓名、常用语言或语气、居住地区、职业与领域、长期目标、反复出现的约定等。\n" +
          "不要收录：只针对当前单次话题的结论、临时任务、一次性事实、或对某个具体文件/代码片段的描述。\n" +
          "输出**仅**一个 JSON 对象，键为 `lines`，值为字符串数组（每项一条中文要点，无则空数组）。不要 markdown 围栏或其它说明。最多 8 条。",
      },
      { role: "user", content: body },
    ],
    { model, maxTokens: 1024 },
  );

  let parsed: { lines?: unknown };
  try {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/m);
    const jsonStr = (fenced ? fenced[1] : trimmed).trim();
    parsed = JSON.parse(jsonStr) as { lines?: unknown };
  } catch {
    return deltaLines;
  }
  const arr = parsed.lines;
  if (!Array.isArray(arr)) return deltaLines;
  const out: string[] = [];
  for (const x of arr) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (t) out.push(t);
    if (out.length >= 8) break;
  }
  return out.length > 0 ? out : deltaLines;
}

export type UserFactsPromotionConfig = {
  userFactsStore: UserFactsStore;
  /** 用于可选的 LLM 筛选 */
  completeNonStreaming: CompleteNonStreaming;
  promoteWithLlm: boolean;
  promoteModel: string;
};

/**
 * 供 `createEnqueueFold` 的 `onAfterFold`：把本轮会话 facts 的**新增行**合并进用户级存储。
 */
export function createAfterFoldUserFactsPromotion(config: UserFactsPromotionConfig) {
  return async function onAfterFold(params: {
    session: SessionMemory;
    previousSummary: string | undefined;
    previousFacts: string | undefined;
  }): Promise<void> {
    const delta = lineDeltaFromFacts(params.previousFacts, params.session.facts);
    if (delta.length === 0) return;

    let toMerge = delta;
    if (config.promoteWithLlm) {
      try {
        toMerge = await extractCrossSessionLinesWithLlm(
          delta,
          config.userFactsStore.getFacts(),
          config.completeNonStreaming,
          config.promoteModel,
        );
      } catch (e) {
        console.error("[UserFactsStore] LLM 提升用户级事实失败，回退为写入全部增量行:", e);
        toMerge = delta;
      }
    }
    config.userFactsStore.mergeLines(toMerge);
  };
}
