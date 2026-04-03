import {
  fetchNonStreaming,
  streamChatCompletionRound,
  type StreamRoundResult,
} from "../services/llm/client.js";
import type { ChatMessage } from "../services/llm/types.js";
import {
  executeToolCall,
  getDefaultTools,
  MAX_TOOL_ROUNDS,
} from "../tools/registry.js";

export type RunWithToolsOptions = {
  chatUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  cwd: string;
  signal: AbortSignal;
  /**
   * 简短状态提示（一行级别），不包含工具原始输出或长正文。
   * 用于终端里 Spinner 旁展示进度。
   */
  onStatus?: (hint: string) => void;
  /** 每一轮向模型发起流式请求前清空 UI 缓冲（避免多轮串台） */
  onStreamReset?: () => void;
  /** 当前轮模型正文增量（流式） */
  onStreamDelta?: (chunk: string) => void;
};

export type RunWithToolsResult = {
  /** 仅最终对用户展示的助手正文（不含工具过程 dump） */
  assistantText: string;
  error?: string;
};

function shortenToolList(names: string[], maxLen = 72): string {
  const s = names.join(", ");
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

/**
 * LLM ↔ 工具循环：非流式多轮，直到无 tool_calls 或达到轮数上限。
 * 会就地修改 `messages`（追加 assistant / tool）。
 */
export async function runWithTools(
  opts: RunWithToolsOptions,
): Promise<RunWithToolsResult> {
  const tools = getDefaultTools();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    opts.signal.throwIfAborted();
    opts.onStreamReset?.();
    opts.onStatus?.(`第 ${round + 1} 轮：正在请求模型…`);

    let streamed = await streamChatCompletionRound({
      chatUrl: opts.chatUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      messages: opts.messages,
      tools,
      tool_choice: "auto",
      temperature: 0.4,
      signal: opts.signal,
      onTextDelta: opts.onStreamDelta,
    });

    let msg: StreamRoundResult["message"] = streamed.message;
    let calls = msg.tool_calls;

    if (
      streamed.finish_reason === "tool_calls" &&
      (!calls || calls.length === 0)
    ) {
      opts.onStreamReset?.();
      opts.onStatus?.(
        `第 ${round + 1} 轮：流式未返回工具结构，改用非流式补全…`,
      );
      const fb = await fetchNonStreaming({
        chatUrl: opts.chatUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        messages: opts.messages,
        tools,
        tool_choice: "auto",
        temperature: 0.4,
        signal: opts.signal,
      });
      msg = {
        role: "assistant",
        content: fb.message.content ?? null,
        tool_calls: fb.message.tool_calls,
      };
      calls = msg.tool_calls;
    }

    if (calls?.length) {
      opts.onStreamReset?.();
      const names = calls.map((c) => c.function.name);
      opts.onStatus?.(
        `第 ${round + 1} 轮：调用工具 (${calls.length})：${shortenToolList(names)}`,
      );

      opts.messages.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: calls,
      });

      const pairs = await Promise.all(
        calls.map(async (tc) => {
          const out = await executeToolCall(tc, opts.cwd, opts.signal);
          return { tc, out };
        }),
      );

      for (const { tc, out } of pairs) {
        opts.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: out,
        });
      }
      opts.onStatus?.(`第 ${round + 1} 轮：已收到工具结果，继续请求模型…`);
      continue;
    }

    opts.messages.push({
      role: "assistant",
      content: msg.content ?? null,
    });
    const final = msg.content?.trim() ?? "";
    const out = final || "(无正文)";
    return { assistantText: out };
  }

  const errMsg = `已达到工具调用轮数上限（${MAX_TOOL_ROUNDS}），请缩小任务范围后重试。`;
  opts.messages.push({
    role: "assistant",
    content: errMsg,
  });
  opts.onStatus?.("已达轮次上限");
  return {
    assistantText: errMsg,
    error: errMsg,
  };
}
