import "./load-env.js";
import { loadMemoryChatbotBehaviorConfig } from "./chat-env.js";
import type { SessionMemory } from "./chat-types.js";
import { createCompleteNonStreaming, joinUrl } from "./deepseek-client.js";
import { parseSseDataLine } from "./deepseek-sse.js";
import { filterDialogueByEntropyPrinciple } from "./entropy-ppl-filter.js";
import { createEnqueueFold, createMemoryFold } from "./memory-fold.js";
import { popIncrementalSummaryBatch, totalTurnChars, trimTurnsIfOverLimit } from "./memory-turns.js";
import { buildSystemContent } from "./system-content.js";
import { readUtf8Lines } from "../shared/stream-read.js";

const sessions = new Map<string, SessionMemory>();

/** 仅覆盖 API 与人设；记忆策略、熵过滤等见环境变量 */
export type MemoryChatbotOptions = {
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  baseURL?: string;
  apiKey?: string;
};

/**
 * 创建带会话记忆的流式聊天实例：熵过滤 → 主对话流式输出 → 写入 turns → 增量摘要与超长裁切折叠。
 * 记忆策略由环境变量控制（见 `loadMemoryChatbotBehaviorConfig`）。
 */
export function createMemoryChatbot(options?: MemoryChatbotOptions) {
  const apiKey = options?.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const baseURL = options?.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const model = options?.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  const temperature = options?.temperature ?? 0.7;
  const systemPrompt =
    options?.systemPrompt ??
    "你的名字是「知忆」，一位沉稳、专业的中文对话伙伴。根据完整对话历史作答，主动记住用户提到的偏好、事实与约定，并在后续回复中自然运用。语气简洁有礼，避免机械套话。";

  const behavior = loadMemoryChatbotBehaviorConfig(model);
  const chatUrl = joinUrl(baseURL, "/v1/chat/completions");
  const completeNonStreaming = createCompleteNonStreaming({
    chatUrl,
    apiKey: apiKey ?? "",
    defaultModel: model,
  });
  const { foldDroppedIntoLayers } = createMemoryFold(completeNonStreaming);
  const enqueueFold = createEnqueueFold(foldDroppedIntoLayers, behavior.summarizeOnTrim);

  /**
   * 单轮对话主流程：取/建会话 → 组消息（可选熵过滤）→ 流式请求 → 持久化本轮 → 触发摘要队列。
   */
  async function* streamChat(input: string, sessionId: string): AsyncGenerator<string> {
    if (!apiKey) {
      throw new Error("未配置 DEEPSEEK_API_KEY");
    }

    let session = sessions.get(sessionId);
    if (!session) {
      session = { turns: [] };
      sessions.set(sessionId, session);
    }

    const systemContent = buildSystemContent(session, systemPrompt);
    let turnsForApi = session.turns;
    let userContentForApi = input;

    const historyChars = totalTurnChars(turnsForApi) + userContentForApi.length;
    const shouldEntropyFilter =
      behavior.entropyPerplexityFilter &&
      (behavior.entropyFilterMinChars === 0 || historyChars >= behavior.entropyFilterMinChars);

    if (shouldEntropyFilter) {
      const asTurns = turnsForApi as Array<{ role: "user" | "assistant"; content: string }>;
      try {
        const filtered = await filterDialogueByEntropyPrinciple(
          asTurns,
          userContentForApi,
          completeNonStreaming,
          { model: behavior.entropyFilterModel, maxTokens: behavior.entropyFilterMaxTokens },
        );
        turnsForApi = filtered.turns;
        userContentForApi = filtered.currentUser;
      } catch (e) {
        console.error("entropy/perplexity context filter failed:", e);
      }
    }

    const messages = [
      { role: "system" as const, content: systemContent },
      ...turnsForApi,
      { role: "user" as const, content: userContentForApi },
    ];

    const res = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        messages,
        stream: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`DeepSeek API ${res.status}: ${errText}`);
    }

    let assistantFull = "";
    for await (const line of readUtf8Lines(res.body)) {
      const text = parseSseDataLine(line);
      if (text) {
        assistantFull += text;
        yield text;
      }
    }

    session.turns.push({ role: "user", content: input });
    session.turns.push({ role: "assistant", content: assistantFull });

    const droppedIncremental = popIncrementalSummaryBatch(session, behavior.incrementalSummaryEveryNPairs);
    enqueueFold(session, droppedIncremental, "incremental");

    const droppedTrim = trimTurnsIfOverLimit(session, behavior);
    enqueueFold(session, droppedTrim, "trim");
  }

  return {
    /** 按会话流式生成助手回复文本片段（AsyncGenerator） */
    stream: (input: string, sessionId: string) => streamChat(input, sessionId),
    /** 删除指定 `sessionId` 的会话记忆 */
    clearSession: (sessionId: string) => {
      sessions.delete(sessionId);
    },
    /** 清空内存中全部会话 */
    clearAllSessions: () => {
      sessions.clear();
    },
  };
}

export type MemoryChatbot = ReturnType<typeof createMemoryChatbot>;
