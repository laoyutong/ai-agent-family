import "./load-env.js";
import { loadMemoryChatbotBehaviorConfig, parseEnvBool } from "./chat-env.js";
import type { SessionMemory } from "./chat-types.js";
import { createCompleteNonStreaming, joinUrl } from "./deepseek-client.js";
import { parseSseDataLine } from "./deepseek-sse.js";
import { filterDialogueByEntropyPrinciple } from "./entropy-ppl-filter.js";
import { createEnqueueFold, createMemoryFold } from "./memory-fold.js";
import { popIncrementalSummaryBatch, totalTurnChars, trimTurnsIfOverLimit } from "./memory-turns.js";
import { loadChatMcpPayloadLimits } from "./chat-mcp-limits.js";
import { shouldUseMcpSandboxForTurn, streamChatWithMcpTools } from "./chat-mcp-tools.js";
import { buildSystemContent } from "./system-content.js";
import type { McpPool } from "./mcp.js";
import type { SessionStore } from "./session-store.js";
import { readUtf8Lines } from "../shared/stream-read.js";

const fallbackSessions = new Map<string, SessionMemory>();

/** 仅覆盖 API 与人设；记忆策略、熵过滤等见环境变量 */
export type MemoryChatbotOptions = {
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  baseURL?: string;
  apiKey?: string;
  /** 传入则在本轮可走 MCP 代码沙盒路径：先 listTools 一次，结果传入 streamChatWithMcpTools 生成门面 */
  mcp?: McpPool;
  /** 传入则多会话持久化到本地文件；不传则仅内存 Map（与旧行为一致） */
  sessionStore?: SessionStore;
};

/**
 * 创建带会话记忆的流式聊天实例：熵过滤 → 主对话流式输出 → 写入 turns → 增量摘要与超长裁切折叠。
 * 记忆策略由环境变量控制（见 `loadMemoryChatbotBehaviorConfig`）。
 */
export function createMemoryChatbot(options?: MemoryChatbotOptions) {
  const mcpPool = options?.mcp;
  const sessionStore = options?.sessionStore;
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
  const enqueueFold = createEnqueueFold(foldDroppedIntoLayers, behavior.summarizeOnTrim, {
    onFoldSettled: sessionStore ? (id) => sessionStore.onFoldSettled(id) : undefined,
  });

  function getSession(sessionId: string): SessionMemory {
    if (sessionStore) {
      return sessionStore.getOrCreateMemory(sessionId);
    }
    let session = fallbackSessions.get(sessionId);
    if (!session) {
      session = { turns: [] };
      fallbackSessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * 单轮用户消息：取/建会话 → 组 messages（可选熵过滤）
   * → 若 MCP 有工具且路由判定需要外部能力则走 streamChatWithMcpTools（代码沙盒 + 最终流式），否则 DeepSeek 流式
   * → 写入 turns → 摘要/裁切队列。
   */
  async function* streamChat(input: string, sessionId: string): AsyncGenerator<string> {
    if (!apiKey) {
      throw new Error("未配置 DEEPSEEK_API_KEY");
    }

    const session = getSession(sessionId);
    const wasEmptyBeforeTurn = session.turns.length === 0;

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

    if (mcpPool?.configured) {
      try {
        const listed = await mcpPool.listTools();
        if (listed.length > 0) {
          const limits = loadChatMcpPayloadLimits();
          let useMcpPath = true;
          if (parseEnvBool("CHAT_MCP_TURN_ROUTER", true)) {
            try {
              useMcpPath = await shouldUseMcpSandboxForTurn({
                chatUrl,
                apiKey: apiKey!,
                model,
                userMessage: userContentForApi,
                listed,
                limits,
              });
            } catch (e) {
              console.error("MCP 路由判断失败，回退为走 MCP 路径:", e);
            }
          }
          if (useMcpPath) {
            let assistantFull = "";
            for await (const chunk of streamChatWithMcpTools({
              mcp: mcpPool,
              chatBaseUrl: baseURL,
              apiKey: apiKey!,
              model,
              temperature,
              messages,
              toolsList: listed,
            })) {
              assistantFull += chunk;
              yield chunk;
            }
            session.turns.push({ role: "user", content: input });
            session.turns.push({ role: "assistant", content: assistantFull });
            sessionStore?.onTurnCommitted(sessionId, input, wasEmptyBeforeTurn);

            const droppedIncremental = popIncrementalSummaryBatch(session, behavior.incrementalSummaryEveryNPairs);
            enqueueFold(session, droppedIncremental, "incremental", sessionId);

            const droppedTrim = trimTurnsIfOverLimit(session, behavior);
            enqueueFold(session, droppedTrim, "trim", sessionId);
            return;
          }
        }
      } catch (e) {
        console.error("MCP 工具对话失败，回退为普通流式:", e);
      }
    }

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
    sessionStore?.onTurnCommitted(sessionId, input, wasEmptyBeforeTurn);

    const droppedIncremental = popIncrementalSummaryBatch(session, behavior.incrementalSummaryEveryNPairs);
    enqueueFold(session, droppedIncremental, "incremental", sessionId);

    const droppedTrim = trimTurnsIfOverLimit(session, behavior);
    enqueueFold(session, droppedTrim, "trim", sessionId);
  }

  return {
    /** 按会话流式生成助手回复文本片段（AsyncGenerator） */
    stream: (input: string, sessionId: string) => streamChat(input, sessionId),
    /** 清空指定会话的逐轮记忆与摘要层，保留会话 id（与侧栏条目） */
    clearSession: (sessionId: string) => {
      if (sessionStore) {
        sessionStore.clearMemory(sessionId);
      } else {
        const s = fallbackSessions.get(sessionId);
        if (s) {
          s.turns = [];
          delete s.summary;
          delete s.facts;
          s.foldChain = undefined;
        }
      }
    },
    /** 清空全部会话（含持久化库中的条目） */
    clearAllSessions: () => {
      if (sessionStore) {
        sessionStore.clearAllSessions();
      } else {
        fallbackSessions.clear();
      }
    },
  };
}

export type MemoryChatbot = ReturnType<typeof createMemoryChatbot>;
