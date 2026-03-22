import type { ChatMessage } from "./chat-types.js";

/** 拼接 API 根地址与路径，避免重复或缺失斜杠 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

export type CompleteNonStreaming = (
  messages: ChatMessage[],
  req?: { model?: string; maxTokens?: number },
) => Promise<string>;

/** 构造非流式 chat/completions 请求函数，供摘要、熵过滤等复用 */
export function createCompleteNonStreaming(options: {
  chatUrl: string;
  apiKey: string;
  defaultModel: string;
}): CompleteNonStreaming {
  const { chatUrl, apiKey, defaultModel } = options;

  /** 调用非流式补全并返回助手正文 */
  return async function completeNonStreaming(
    messages: ChatMessage[],
    req?: { model?: string; maxTokens?: number },
  ): Promise<string> {
    if (!apiKey) {
      throw new Error("未配置 DEEPSEEK_API_KEY");
    }
    const body: Record<string, unknown> = {
      model: req?.model ?? defaultModel,
      temperature: 0.2,
      messages,
      stream: false,
    };
    if (req?.maxTokens != null && req.maxTokens > 0) {
      body.max_tokens = req.maxTokens;
    }
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`DeepSeek API ${res.status}: ${errText}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error("摘要接口返回内容为空");
    }
    return text.trim();
  };
}
