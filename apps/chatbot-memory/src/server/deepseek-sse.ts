/**
 * 解析 OpenAI 兼容流式响应中**单行** SSE：提取 `choices[0].delta.content` 中的增量文本；
 * 非 data 行、`[DONE]`、解析失败时返回 null。
 */
export function parseSseDataLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return null;
  try {
    const json = JSON.parse(data) as {
      choices?: { delta?: { content?: string | null } }[];
    };
    const delta = json.choices?.[0]?.delta?.content;
    return typeof delta === "string" && delta.length > 0 ? delta : null;
  } catch {
    return null;
  }
}
