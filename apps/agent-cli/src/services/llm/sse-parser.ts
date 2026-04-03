/**
 * 解析 OpenAI 兼容流式 SSE 单行：增量正文、API 错误、[DONE]。
 * 与 apps/chatbot-memory/src/server/llm/deepseek-sse.ts 行为对齐并扩展错误行。
 */
export type SseLineParsed =
  | { kind: "text"; text: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

export function parseSseLine(line: string): SseLineParsed | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return { kind: "done" };

  try {
    const json = JSON.parse(data) as {
      error?: { message?: string };
      choices?: { delta?: { content?: string | null } }[];
    };
    if (json.error?.message) {
      return { kind: "error", message: json.error.message };
    }
    const delta = json.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      return { kind: "text", text: delta };
    }
    return null;
  } catch {
    return null;
  }
}

/** OpenAI 流式 tool_calls 增量项 */
export type ToolCallStreamDelta = {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

/**
 * 解析 chat/completions 流式行：正文片、tool_calls 增量、finish_reason。
 */
export type ChatStreamSseParsed =
  | {
      kind: "delta";
      content?: string;
      toolCalls?: ToolCallStreamDelta[];
      finishReason?: string | null;
    }
  | { kind: "done" }
  | { kind: "error"; message: string };

export function parseChatStreamSseLine(line: string): ChatStreamSseParsed | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return { kind: "done" };

  try {
    const json = JSON.parse(data) as {
      error?: { message?: string };
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: ToolCallStreamDelta[];
          role?: string;
        };
        finish_reason?: string | null;
      }>;
    };
    if (json.error?.message) {
      return { kind: "error", message: json.error.message };
    }
    const ch = json.choices?.[0];
    if (!ch) return null;

    const fr =
      ch.finish_reason !== undefined && ch.finish_reason !== null
        ? ch.finish_reason
        : undefined;
    const d = ch.delta;
    const content =
      typeof d?.content === "string" && d.content.length > 0
        ? d.content
        : undefined;
    const toolCalls =
      d?.tool_calls && d.tool_calls.length > 0 ? d.tool_calls : undefined;

    const hasFr = fr !== undefined && fr !== null && String(fr).length > 0;

    if (!content && !toolCalls && !hasFr) {
      return null;
    }

    return {
      kind: "delta",
      content,
      toolCalls,
      finishReason: hasFr ? fr : undefined,
    };
  } catch {
    return null;
  }
}
