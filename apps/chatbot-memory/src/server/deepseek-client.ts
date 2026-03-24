import type { ChatMessage } from "./chat-types.js";

/** OpenAI 兼容 chat/completions 的 message 行（非流式） */
export type ChatCompletionMessageRow = { role: string; content?: string | null };

/**
 * 非流式 chat/completions：返回 choices[0].message（含 content，可为 null）。
 * 与 `createCompleteNonStreaming` 区分：支持自定义 temperature、任意 role 组合。
 */
export async function fetchChatCompletionNonStream(options: {
  chatUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  messages: ChatCompletionMessageRow[];
}): Promise<{ content?: string | null }> {
  const { chatUrl, apiKey, model, temperature, messages } = options;
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
      stream: false,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${errText}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw new Error("模型返回无 message");
  return { content: message.content };
}

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
