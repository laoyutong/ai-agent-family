import chalk from "chalk";
import {
  fetchNonStreaming,
  streamChatCompletionRound,
  type StreamRoundResult,
} from "../services/llm/client.js";
import type { ChatMessage, ToolCall } from "../services/llm/types.js";
import {
  executeToolCall,
  getDefaultTools,
  MAX_TOOL_ROUNDS,
} from "../tools/registry.js";
import {
  formatToolOutcomeSummary,
  formatToolRunning,
  type RunStatusUpdate,
} from "./status-step.js";

export type { AgentStep, RunStatusUpdate } from "./status-step.js";

export type RunWithToolsOptions = {
  chatUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  cwd: string;
  signal: AbortSignal;
  /**
   * Spinner 旁短文案；可选追加一条结构化步骤（工具面板与对话历史共用）。
   */
  onStatus?: (update: RunStatusUpdate) => void;
  /**
   * 流式工具结构不完整、即将非流式补全时清空 UI 缓冲（丢弃不可靠的流式片段）。
   * 不在每轮请求前或工具执行前调用，以便同一用户轮内保留已流式输出的正文。
   */
  onStreamReset?: () => void;
  /**
   * 新一轮模型流式输出开始（round > 0，例如工具执行之后）。
   * UI 可据此新开一列/一段，不与上一轮正文合并。
   */
  onStreamSegmentStart?: () => void;
  /** 当前轮模型正文增量（流式） */
  onStreamDelta?: (chunk: string) => void;
};

export type RunWithToolsResult = {
  /** 仅最终对用户展示的助手正文（不含工具过程 dump） */
  assistantText: string;
  error?: string;
};

function clipLogLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * 工具执行轨迹仅写 stderr，与 Ink 里「助手气泡」正文+步骤分离，避免终端里和对话区混成一团。
 * 需要对照执行细节时：`AURA_CODE_LOG_TOOLS=1`。
 */
function toolTraceToStderr(): boolean {
  return process.env.AURA_CODE_LOG_TOOLS === "1";
}

function logToolRunStart(tc: ToolCall): void {
  if (!toolTraceToStderr()) return;
  const r = formatToolRunning(tc);
  console.error(chalk.dim("·"), chalk.hex("#c9a227")("[工具]"), r.title);
}

function logToolRunEnd(tc: ToolCall, out: string): void {
  if (!toolTraceToStderr()) return;
  const r = formatToolRunning(tc);
  const err = out.trimStart().startsWith("错误：");
  if (err) {
    const first = (out.trim().split("\n")[0] ?? "").trim();
    console.error(
      chalk.dim("·"),
      chalk.red("[失败]"),
      r.title,
      chalk.dim(clipLogLine(first, 160)),
    );
    return;
  }
  const trimmed = out.trim();
  const suffix =
    trimmed.length === 0
      ? chalk.dim("(无输出)")
      : chalk.dim(`(返回 ${trimmed.length} 字)`);
  console.error(
    chalk.dim("·"),
    chalk.green("[完成]"),
    r.title,
    suffix,
  );
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
    opts.onStatus?.(
      round > 0
        ? {
            spinnerHint: "请求模型…",
            step: { tone: "round", title: "" },
          }
        : { spinnerHint: "请求模型…" },
    );

    if (round > 0) {
      opts.onStreamSegmentStart?.();
    }

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
      opts.onStatus?.({ spinnerHint: "流式工具结构不完整 · 非流式补全" });
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
      if (calls.length === 1) {
        const tc = calls[0]!;
        opts.onStatus?.({
          spinnerHint: `${tc.function.name} · 运行`,
          step: formatToolRunning(tc),
        });
      } else {
        opts.onStatus?.({
          spinnerHint: `并行 ${calls.length} 个工具`,
        });
      }

      opts.messages.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: calls,
      });

      const pairs = await Promise.all(
        calls.map(async (tc) => {
          logToolRunStart(tc);
          const out = await executeToolCall(tc, opts.cwd, opts.signal);
          logToolRunEnd(tc, out);
          return { tc, out };
        }),
      );

      for (const { tc, out } of pairs) {
        opts.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: out,
        });
        const runningStep = formatToolRunning(tc);
        const failed = out.trimStart().startsWith("错误：");
        opts.onStatus?.({
          spinnerHint: `${tc.function.name} · ${failed ? "失败" : "完成"}`,
          step: {
            tone: "invoke",
            title: runningStep.title,
            toolCallId: runningStep.toolCallId,
            ...(failed
              ? { outcome: formatToolOutcomeSummary(tc, out) }
              : { invokeComplete: true }),
          },
        });
      }
      opts.onStatus?.({ spinnerHint: "请求模型…" });
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
  opts.onStatus?.({
    spinnerHint: `已达工具调用轮数上限（${MAX_TOOL_ROUNDS}）`,
    step: {
      tone: "fail",
      title: "已达轮次上限",
      detail: `已进行 ${MAX_TOOL_ROUNDS} 轮，请缩小任务范围后重试`,
    },
  });
  return {
    assistantText: errMsg,
    error: errMsg,
  };
}
