import "./load-env.js";
import { readUtf8Lines } from "../shared/stream-read.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type SessionMemory = {
  /** 交替 user / assistant，不含 system */
  turns: ChatMessage[];
  /** 被裁切对话折叠后的要点（可选） */
  summary?: string;
};

const sessions = new Map<string, SessionMemory>();

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function parseIntEnv(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
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

function totalTurnChars(turns: ChatMessage[]): number {
  return turns.reduce((s, m) => s + m.content.length, 0);
}

function formatTurnsForSummary(turns: ChatMessage[]): string {
  return turns.map((m) => `${m.role}: ${m.content}`).join("\n");
}

export function createMemoryChatbot(options?: {
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  baseURL?: string;
  apiKey?: string;
  /** 最多保留的对话轮数（user+assistant 算一轮）；0 表示不按轮数裁切 */
  maxHistoryPairs?: number;
  /** 历史总字符上限（user+assistant 正文）；0 表示不按字符裁切 */
  maxHistoryChars?: number;
  /** 裁切时是否调用模型将去掉的部分折叠进 summary（多一次非流式请求） */
  summarizeOnTrim?: boolean;
}) {
  const apiKey = options?.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const baseURL = options?.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const model = options?.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  const temperature = options?.temperature ?? 0.7;
  const systemPrompt =
    options?.systemPrompt ??
    "你的名字是「知忆」，一位沉稳、专业的中文对话伙伴。根据完整对话历史作答，主动记住用户提到的偏好、事实与约定，并在后续回复中自然运用。语气简洁有礼，避免机械套话。";

  const maxHistoryPairs =
    options?.maxHistoryPairs ?? parseIntEnv("CHAT_HISTORY_MAX_PAIRS", 30);
  const maxHistoryChars =
    options?.maxHistoryChars ?? parseIntEnv("CHAT_HISTORY_MAX_CHARS", 0);
  const summarizeOnTrim =
    options?.summarizeOnTrim ??
    (process.env.CHAT_HISTORY_SUMMARIZE === "1" || process.env.CHAT_HISTORY_SUMMARIZE === "true");

  const chatUrl = joinUrl(baseURL, "/v1/chat/completions");

  function buildSystemContent(summary: string | undefined): string {
    if (!summary?.trim()) return systemPrompt;
    return `${systemPrompt}\n\n【会话前期摘要】\n${summary.trim()}`;
  }

  async function completeNonStreaming(messages: ChatMessage[]): Promise<string> {
    if (!apiKey) {
      throw new Error("未配置 DEEPSEEK_API_KEY");
    }
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
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
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error("摘要接口返回内容为空");
    }
    return text.trim();
  }

  async function foldDroppedIntoSummary(
    previousSummary: string | undefined,
    dropped: ChatMessage[],
  ): Promise<string> {
    const body = [
      previousSummary?.trim() ? `既有摘要：\n${previousSummary.trim()}\n\n` : "",
      `待合并对话：\n${formatTurnsForSummary(dropped)}`,
    ].join("");
    return completeNonStreaming([
      {
        role: "system",
        content:
          "你是对话摘要助手。将「既有摘要」（若有）与「待合并对话」合并为一段简短中文要点，保留事实、偏好、约定与专有名词，省略寒暄与重复。控制在约 800 字以内。",
      },
      { role: "user", content: body },
    ]);
  }

  async function compactAfterTurn(session: SessionMemory): Promise<void> {
    const { turns } = session;
    const dropped: ChatMessage[] = [];

    while (turns.length >= 2) {
      const pairCount = turns.length / 2;
      const overPairs = maxHistoryPairs > 0 && pairCount > maxHistoryPairs;
      const overChars = maxHistoryChars > 0 && totalTurnChars(turns) > maxHistoryChars;
      if (!overPairs && !overChars) break;
      dropped.push(turns.shift()!, turns.shift()!);
    }

    if (dropped.length === 0) return;

    if (summarizeOnTrim) {
      try {
        session.summary = await foldDroppedIntoSummary(session.summary, dropped);
      } catch (e) {
        console.error("chat history summarize failed:", e);
      }
    }
  }

  async function* streamChat(input: string, sessionId: string): AsyncGenerator<string> {
    if (!apiKey) {
      throw new Error("未配置 DEEPSEEK_API_KEY");
    }

    let session = sessions.get(sessionId);
    if (!session) {
      session = { turns: [] };
      sessions.set(sessionId, session);
    }

    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemContent(session.summary) },
      ...session.turns,
      { role: "user", content: input },
    ];

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
        stream: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`DeepSeek API ${res.status}: ${errText}`);
    }

    let assistantFull = "";
    for await (const line of readUtf8Lines(res.body)) {
      const text = parseSseDataLine(line);
      if (text) {
        assistantFull += text;
        yield text;
      }
    }

    session.turns.push({ role: "user", content: input });
    session.turns.push({ role: "assistant", content: assistantFull });

    await compactAfterTurn(session);
  }

  return {
    /** 流式输出文本片段，用于 SSE */
    stream: (input: string, sessionId: string) => streamChat(input, sessionId),
    clearSession: (sessionId: string) => {
      sessions.delete(sessionId);
    },
    clearAllSessions: () => {
      sessions.clear();
    },
  };
}

export type MemoryChatbot = ReturnType<typeof createMemoryChatbot>;
