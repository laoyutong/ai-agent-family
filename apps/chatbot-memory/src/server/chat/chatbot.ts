import {
  loadFoldArchiveInjectConfig,
  loadMemoryChatbotBehaviorConfig,
  parseEnvBool,
} from "../config/chat-env.js";
import { createCompleteNonStreaming, joinUrl } from "../llm/deepseek-client.js";
import { parseSseDataLine } from "../llm/deepseek-sse.js";
import { loadChatMcpPayloadLimits } from "../mcp/chat-mcp-limits.js";
import {
  inferMcpRouteByHeuristic,
  shouldUseMcpSandboxForTurn,
  streamChatWithMcpTools,
} from "../mcp/chat-mcp-tools.js";
import type { McpPool } from "../mcp/mcp.js";
import type { FoldArchiveStore } from "../persistence/fold-archive-store.js";
import type { SessionStore } from "../persistence/session-store.js";
import type { UserFactsStore } from "../persistence/user-facts-store.js";
import { readUtf8Lines, type ChatStreamPart } from "../shared/index.js";
import type { ChatMessage, SessionMemory } from "./chat-types.js";
import { filterDialogueByEntropyPrinciple } from "./entropy-ppl-filter.js";
import { createEnqueueFold, createMemoryFold, type FoldArchiveEnqueueRef } from "./memory-fold.js";
import { popIncrementalSummaryBatch, totalTurnChars, trimTurnsIfOverLimit } from "./memory-turns.js";
import { buildSystemContent } from "./system-content.js";
import { buildFoldArchiveInjectBlock } from "./fold-archive-inject.js";
import { createAfterFoldUserFactsPromotion } from "./user-facts-promote.js";

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
  /** 传入则注入跨会话用户级事实，并在记忆折叠后自动合并新要点（见环境变量 CHAT_USER_FACTS_*） */
  userFactsStore?: UserFactsStore;
  /**
   * 折叠进摘要前：被移出的原始轮次（可在此写入本地归档）。
   * 返回 `{ index, createdAt }` 可与 `onFoldArchiveFinalized` 联动做强关联。
   */
  onFoldDroppedArchive?: (params: {
    sessionId: string;
    mode: "incremental" | "trim";
    dropped: ChatMessage[];
  }) => void | Promise<void | FoldArchiveEnqueueRef | null | undefined>;
  /** 归档已写且本轮折叠成功、会话 summary/facts 已更新后（如回填 layers、写入 `foldArchiveLinks`） */
  onFoldArchiveFinalized?: (params: {
    sessionId: string;
    mode: "incremental" | "trim";
    ref: FoldArchiveEnqueueRef;
    session: SessionMemory;
    previousSummary: string | undefined;
    previousFacts: string | undefined;
  }) => void | Promise<void>;
  /** 传入则每轮对话自动将 `foldArchiveLinks` 对应磁盘归档节选拼入 system（需与归档存储同时启用） */
  foldArchiveInjectStore?: FoldArchiveStore;
};

/**
 * 创建带会话记忆的流式聊天实例：熵过滤 → 主对话流式输出 → 写入 turns → 增量摘要与超长裁切折叠。
 * 记忆策略由环境变量控制（见 `loadMemoryChatbotBehaviorConfig`）。
 */
export function createMemoryChatbot(options?: MemoryChatbotOptions) {
  const mcpPool = options?.mcp;
  const sessionStore = options?.sessionStore;
  const userFactsStore = options?.userFactsStore;
  const apiKey = options?.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const baseURL = options?.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const model = options?.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  const temperature = options?.temperature ?? 0.7;
  const systemPrompt =
    options?.systemPrompt ??
    "你的名字是「知忆」，一位沉稳、专业的中文对话伙伴。根据完整对话历史作答，主动记住用户提到的偏好、事实与约定，并在后续回复中自然运用。语气简洁有礼，避免机械套话。";

  const behavior = loadMemoryChatbotBehaviorConfig(model);
  const foldArchiveInjectStore = options?.foldArchiveInjectStore;
  const foldArchiveInjectCfg = foldArchiveInjectStore ? loadFoldArchiveInjectConfig() : null;
  const chatUrl = joinUrl(baseURL, "/v1/chat/completions");
  const completeNonStreaming = createCompleteNonStreaming({
    chatUrl,
    apiKey: apiKey ?? "",
    defaultModel: model,
  });
  const { foldDroppedIntoLayers } = createMemoryFold(completeNonStreaming);
  const promoteUserFactsWithLlm = userFactsStore
    ? parseEnvBool("CHAT_USER_FACTS_PROMOTE_LLM", false)
    : false;
  const promoteUserFactsModel =
    process.env.CHAT_USER_FACTS_PROMOTE_MODEL?.trim() || model;

  const enqueueFold = createEnqueueFold(foldDroppedIntoLayers, behavior.summarizeOnTrim, {
    onFoldSettled: sessionStore ? (id) => sessionStore.onFoldSettled(id) : undefined,
    onArchiveDropped: options?.onFoldDroppedArchive,
    onFoldArchiveFinalized: options?.onFoldArchiveFinalized,
    onAfterFold:
      userFactsStore &&
      createAfterFoldUserFactsPromotion({
        userFactsStore,
        completeNonStreaming,
        promoteWithLlm: promoteUserFactsWithLlm,
        promoteModel: promoteUserFactsModel,
      }),
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
  async function* streamChat(input: string, sessionId: string): AsyncGenerator<ChatStreamPart> {
    if (!apiKey) {
      throw new Error("未配置 DEEPSEEK_API_KEY");
    }

    const session = getSession(sessionId);
    const wasEmptyBeforeTurn = session.turns.length === 0;

    let foldArchiveDigest: string | undefined;
    if (
      foldArchiveInjectStore &&
      foldArchiveInjectCfg?.enabled &&
      session.foldArchiveLinks?.length
    ) {
      foldArchiveDigest = await buildFoldArchiveInjectBlock(
        foldArchiveInjectStore,
        sessionId,
        session.foldArchiveLinks,
        {
          maxEntries: foldArchiveInjectCfg.maxEntries,
          maxTotalChars: foldArchiveInjectCfg.maxTotalChars,
          turnsMaxCharsPerEntry: foldArchiveInjectCfg.turnsMaxCharsPerEntry,
          selectMode: foldArchiveInjectCfg.selectMode,
          relevanceFallback: foldArchiveInjectCfg.relevanceFallback,
        },
        input,
      );
    }

    const systemContent = buildSystemContent(
      session,
      systemPrompt,
      userFactsStore?.getFacts(),
      foldArchiveDigest,
    );
    let turnsForApi = session.turns;
    let userContentForApi = input;

    const historyChars = totalTurnChars(turnsForApi) + userContentForApi.length;
    const shouldEntropyFilter =
      behavior.entropyPerplexityFilter &&
      (behavior.entropyFilterMinChars === 0 || historyChars >= behavior.entropyFilterMinChars);

    const routerEnabled = parseEnvBool("CHAT_MCP_TURN_ROUTER", true);
    const heuristicEnabled = parseEnvBool("CHAT_MCP_ROUTER_HEURISTIC", true);

    let mcpHeuristic: boolean | null = null;
    if (mcpPool?.configured && routerEnabled && heuristicEnabled) {
      mcpHeuristic = inferMcpRouteByHeuristic(input);
    }
    const skipMcpByHeuristic = routerEnabled && heuristicEnabled && mcpHeuristic === false;
    const needToolsList = Boolean(mcpPool?.configured && !skipMcpByHeuristic);

    const asTurns = turnsForApi as Array<{ role: "user" | "assistant"; content: string }>;
    const entropyPromise = (async () => {
      if (!shouldEntropyFilter) return;
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
    })();

    const toolsPromise =
      needToolsList && mcpPool
        ? mcpPool.listTools().catch((e) => {
            console.error("MCP listTools 失败，将回退为普通流式:", e);
            return [] as Awaited<ReturnType<McpPool["listTools"]>>;
          })
        : Promise.resolve([]);

    const [, listed] = await Promise.all([entropyPromise, toolsPromise]);

    const messages = [
      { role: "system" as const, content: systemContent },
      ...turnsForApi,
      { role: "user" as const, content: userContentForApi },
    ];

    if (mcpPool?.configured && !skipMcpByHeuristic) {
      try {
        if (listed.length > 0) {
          const limits = loadChatMcpPayloadLimits();
          let useMcpPath = true;
          if (routerEnabled && mcpHeuristic === null) {
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
              if (chunk.type === "text") assistantFull += chunk.text;
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
        yield { type: "text", text };
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
    /** 清空指定会话的逐轮记忆与摘要层，保留会话 id；持久化时会话标题重置为「新会话」 */
    clearSession: (sessionId: string) => {
      if (sessionStore) {
        sessionStore.clearMemory(sessionId);
      } else {
        const s = fallbackSessions.get(sessionId);
        if (s) {
          s.turns = [];
          delete s.summary;
          delete s.facts;
          delete s.foldArchiveLinks;
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
