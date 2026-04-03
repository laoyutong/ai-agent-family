import type {
  ChatCompletionResult,
  ChatMessage,
  LLMStreamChunk,
  OpenAITool,
  ToolCall,
} from "./types.js";
import {
  parseChatStreamSseLine,
  parseSseLine,
  type ToolCallStreamDelta,
} from "./sse-parser.js";
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

function mergeToolStreamDeltas(
  acc: Map<number, { id: string; name: string; arguments: string }>,
  deltas: ToolCallStreamDelta[],
): void {
  for (const t of deltas) {
    const idx = typeof t.index === "number" ? t.index : 0;
    let cur = acc.get(idx);
    if (!cur) {
      cur = { id: "", name: "", arguments: "" };
      acc.set(idx, cur);
    }
    if (t.id) cur.id = t.id;
    if (t.function?.name) cur.name = t.function.name;
    if (t.function?.arguments) cur.arguments += t.function.arguments;
  }
}

function toolAccToCalls(
  acc: Map<number, { id: string; name: string; arguments: string }>,
): ToolCall[] | undefined {
  if (acc.size === 0) return undefined;
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, v]) => ({
      id: v.id.length > 0 ? v.id : `call_stream_${idx}`,
      type: "function" as const,
      function: { name: v.name, arguments: v.arguments },
    }));
}

export type StreamRoundResult = {
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string | null;
};

export type StreamRoundOptions = FetchStreamingOptions & {
  /** 当前轮次模型正文增量（不包含工具结果） */
  onTextDelta?: (chunk: string) => void;
};

/**
 * 单次 chat/completions 流式请求，聚合完整 assistant 消息（含流式 tool_calls 增量）。
 */
export async function streamChatCompletionRound(
  options: StreamRoundOptions,
): Promise<StreamRoundResult> {
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
    onTextDelta,
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

  let contentBuf = "";
  const toolAcc = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  let finishReason: string | null = null;

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
      const parsed = parseChatStreamSseLine(line);
      if (!parsed) continue;
      if (parsed.kind === "error") {
        throw new Error(parsed.message);
      }
      if (parsed.kind === "done") break;

      if (parsed.kind === "delta") {
        if (parsed.content || parsed.toolCalls?.length) {
          onFirstChunk();
        }
        if (parsed.content) {
          contentBuf += parsed.content;
          onTextDelta?.(parsed.content);
        }
        if (parsed.toolCalls?.length) {
          mergeToolStreamDeltas(toolAcc, parsed.toolCalls);
        }
        if (
          parsed.finishReason != null &&
          String(parsed.finishReason).length > 0
        ) {
          finishReason = parsed.finishReason;
        }
      }
    }
  } finally {
    cleanup();
  }

  const tool_calls = toolAccToCalls(toolAcc);
  return {
    message: {
      role: "assistant",
      content: contentBuf.length > 0 ? contentBuf : null,
      tool_calls,
    },
    finish_reason: finishReason,
  };
}
