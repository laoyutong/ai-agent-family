import "./load-env.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const histories = new Map<string, ChatMessage[]>();

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function parseSseDataLine(line: string): string | null {
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

export function createMemoryChatbot(options?: {
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  baseURL?: string;
  apiKey?: string;
}) {
  const apiKey = options?.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const baseURL = options?.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const model = options?.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  const temperature = options?.temperature ?? 0.7;
  const systemPrompt =
    options?.systemPrompt ??
    "你的名字是「知忆」，一位沉稳、专业的中文对话伙伴。根据完整对话历史作答，主动记住用户提到的偏好、事实与约定，并在后续回复中自然运用。语气简洁有礼，避免机械套话。";

  async function* streamChat(input: string, sessionId: string): AsyncGenerator<string> {
    if (!apiKey) {
      throw new Error("未配置 DEEPSEEK_API_KEY");
    }

    let history = histories.get(sessionId);
    if (!history) {
      history = [];
      histories.set(sessionId, history);
    }

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: input },
    ];

    const url = joinUrl(baseURL, "/v1/chat/completions");
    const res = await fetch(url, {
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

    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("响应体为空");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let assistantFull = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const text = parseSseDataLine(line);
          if (text) {
            assistantFull += text;
            yield text;
          }
        }
        if (done) {
          if (buffer.trim()) {
            const text = parseSseDataLine(buffer);
            if (text) {
              assistantFull += text;
              yield text;
            }
          }
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    history.push({ role: "user", content: input });
    history.push({ role: "assistant", content: assistantFull });
  }

  return {
    /** 流式输出文本片段，用于 SSE */
    stream: (input: string, sessionId: string) => streamChat(input, sessionId),
    clearSession: (sessionId: string) => {
      histories.delete(sessionId);
    },
    clearAllSessions: () => {
      histories.clear();
    },
  };
}

export type MemoryChatbot = ReturnType<typeof createMemoryChatbot>;
