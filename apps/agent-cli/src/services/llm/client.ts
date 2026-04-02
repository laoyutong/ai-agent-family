import type {
  ChatCompletionResult,
  ChatMessage,
  LLMStreamChunk,
  OpenAITool,
} from "./types.js";
import { parseSseLine } from "./sse-parser.js";
import { readUtf8Lines } from "./stream-read.js";

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let lastErr: string | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      await sleep(delay);
    }
    const res = await fetch(url, init);
    if (res.ok) return res;
    const errText = await res.text();
    lastErr = `DeepSeek API ${res.status}: ${errText}`;
    if (!RETRY_STATUSES.has(res.status) || attempt === maxRetries) {
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr ?? "DeepSeek API 请求失败");
}

function attachStreamTimeouts(
  userSignal: AbortSignal | undefined,
  options: { firstChunkMs: number; totalMs: number },
): { signal: AbortSignal; onFirstChunk: () => void; cleanup: () => void } {
  const controller = new AbortController();
  const onUserAbort = (): void => {
    controller.abort();
  };
  if (userSignal) {
    if (userSignal.aborted) onUserAbort();
    else userSignal.addEventListener("abort", onUserAbort, { once: true });
  }

  const totalTimer = setTimeout(onUserAbort, options.totalMs);
  let firstTimer: NodeJS.Timeout | ReturnType<typeof setTimeout> | null =
    setTimeout(onUserAbort, options.firstChunkMs);

  const onFirstChunk = (): void => {
    if (firstTimer != null) {
      clearTimeout(firstTimer);
      firstTimer = null;
    }
  };

  const cleanup = (): void => {
    clearTimeout(totalTimer);
    if (firstTimer != null) clearTimeout(firstTimer);
    if (userSignal) {
      userSignal.removeEventListener("abort", onUserAbort);
    }
  };

  return { signal: controller.signal, onFirstChunk, cleanup };
}

export type FetchNonStreamingOptions = {
  chatUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | "required" | Record<string, unknown>;
  max_tokens?: number;
  signal?: AbortSignal;
};

export async function fetchNonStreaming(
  options: FetchNonStreamingOptions,
): Promise<ChatCompletionResult> {
  const {
    chatUrl,
    apiKey,
    model,
    messages,
    temperature = 0.7,
    tools,
    tool_choice,
    max_tokens,
    signal,
  } = options;

  const body: Record<string, unknown> = {
    model,
    temperature,
    messages,
    stream: false,
  };
  if (tools?.length) {
    body.tools = tools;
    if (tool_choice !== undefined) body.tool_choice = tool_choice;
  }
  if (max_tokens != null && max_tokens > 0) {
    body.max_tokens = max_tokens;
  }

  const res = await fetchWithRetry(chatUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  const json = (await res.json()) as {
    choices?: {
      message?: {
        role?: string;
        content?: string | null;
        tool_calls?: ChatCompletionResult["message"]["tool_calls"];
      };
      finish_reason?: string | null;
    }[];
    error?: { message?: string };
  };

  if (json.error?.message) {
    throw new Error(json.error.message);
  }

  const choice = json.choices?.[0];
  const message = choice?.message;
  if (!message) {
    throw new Error("模型返回无 message");
  }

  return {
    message: {
      role: message.role ?? "assistant",
      content: message.content ?? null,
      tool_calls: message.tool_calls,
    },
    finish_reason: choice.finish_reason ?? null,
  };
}

export type FetchStreamingOptions = {
  chatUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | "required" | Record<string, unknown>;
  signal?: AbortSignal;
  /** 首 token 超时（毫秒），默认 30s */
  firstChunkMs?: number;
  /** 整段流式总时长上限（毫秒），默认 5min */
  totalStreamMs?: number;
};

export async function* fetchStreaming(
  options: FetchStreamingOptions,
): AsyncGenerator<LLMStreamChunk> {
  const {
    chatUrl,
    apiKey,
    model,
    messages,
    temperature = 0.7,
    tools,
    tool_choice,
    signal: userSignal,
    firstChunkMs = 30_000,
    totalStreamMs = 300_000,
  } = options;

  const body: Record<string, unknown> = {
    model,
    temperature,
    messages,
    stream: true,
  };
  if (tools?.length) {
    body.tools = tools;
    if (tool_choice !== undefined) body.tool_choice = tool_choice;
  }

  const { signal, onFirstChunk, cleanup } = attachStreamTimeouts(userSignal, {
    firstChunkMs,
    totalMs: totalStreamMs,
  });

  try {
    const res = await fetchWithRetry(chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    for await (const line of readUtf8Lines(res.body)) {
      const parsed = parseSseLine(line);
      if (!parsed) continue;
      if (parsed.kind === "done") break;
      if (parsed.kind === "error") {
        yield { type: "error", message: parsed.message };
        break;
      }
      onFirstChunk();
      yield { type: "text", text: parsed.text };
    }
  } finally {
    cleanup();
  }
}
