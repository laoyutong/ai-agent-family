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
