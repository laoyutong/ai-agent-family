import "./load-env.js";
import { readUtf8Lines } from "../shared/stream-read.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type SessionMemory = {
  /** 交替 user / assistant，不含 system —— 短期 verbatim，直接进模型上下文 */
  turns: ChatMessage[];
  /** 被裁切部分的叙事脉络（中期压缩） */
  summary?: string;
  /** 从裁切与历史中沉淀的稳定要点：偏好、事实、约定、专有名词等（长期层，每行一条） */
  facts?: string;
  /** 后台摘要任务链，保证多轮裁切时按序合并进 summary/facts，避免并发写竞态 */
  foldChain?: Promise<void>;
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

/** 从模型输出中解析 {"summary":"...","facts":"..."}，失败时抛错 */
function parseLayeredFoldOutput(text: string): { summary: string; facts: string } {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/m);
  const jsonStr = (fenced ? fenced[1] : trimmed).trim();
  const parsed = JSON.parse(jsonStr) as { summary?: unknown; facts?: unknown };
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const facts = typeof parsed.facts === "string" ? parsed.facts.trim() : "";
  return { summary, facts };
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

  /** 长期要点 → 中期摘要 → 基础人设；近期 verbatim 在 messages 的 turns 里 */
  function buildSystemContent(session: Pick<SessionMemory, "summary" | "facts">): string {
    const blocks: string[] = [systemPrompt];
    if (session.facts?.trim()) {
      blocks.push(`【长期要点】（事实、偏好、约定与专有名词；每行一条）\n${session.facts.trim()}`);
    }
    if (session.summary?.trim()) {
      blocks.push(`【会话前期摘要】（已结束话题的叙事脉络）\n${session.summary.trim()}`);
    }
    return blocks.join("\n\n");
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

  /** 单段摘要（仅在分层 JSON 解析失败时作降级） */
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
          "你是对话摘要助手。将「既有摘要」（若有）与「待合并对话」合并为极简中文要点：只写结论、决定与不可替代的专名/数字，不写过程与寒暄，不逐句复述。合并去重后**总长不超过约 300 字**（宁短勿长）。",
      },
      { role: "user", content: body },
    ]);
  }

  /** 记忆分层：一次调用同时更新叙事摘要与长期要点 */
  async function foldDroppedIntoLayers(
    previousSummary: string | undefined,
    previousFacts: string | undefined,
    dropped: ChatMessage[],
  ): Promise<{ summary: string; facts: string }> {
    const userParts: string[] = [];
    if (previousSummary?.trim()) userParts.push(`既有会话摘要：\n${previousSummary.trim()}`);
    if (previousFacts?.trim()) userParts.push(`既有长期要点：\n${previousFacts.trim()}`);
    userParts.push(`待合并对话：\n${formatTurnsForSummary(dropped)}`);
    const userContent = userParts.join("\n\n");

    const raw = await completeNonStreaming([
      {
        role: "system",
        content:
          "你是记忆分层助手。根据「既有会话摘要」「既有长期要点」（可无）与「待合并对话」，输出**仅**一个 JSON 对象，键为 summary 与 facts，不要 markdown 代码块或其它说明文字。\n" +
            "summary：用一两段极短中文概括**仍对后续对话有用**的脉络（话题+结论/立场），不写细节与铺垫；与既有摘要合并去重后**总长不超过约 300 字**。\n" +
            "facts：每行一条，仅用户偏好、硬事实、约定、专名与关键数字；合并既有长期要点并去重，**不超过 20 行**，能合并成一条的不要拆成多条。",
      },
      { role: "user", content: userContent },
    ]);

    try {
      const { summary, facts } = parseLayeredFoldOutput(raw);
      if (!summary && !facts) {
        throw new Error("layered fold empty");
      }
      return {
        summary: summary || (previousSummary?.trim() ?? ""),
        facts: facts || (previousFacts?.trim() ?? ""),
      };
    } catch {
      const summaryOnly = await foldDroppedIntoSummary(previousSummary, dropped);
      return {
        summary: summaryOnly,
        facts: previousFacts?.trim() ?? "",
      };
    }
  }

  /** 仅同步裁切 turns，返回被移出的消息；不调用模型 */
  function trimTurnsIfOverLimit(session: SessionMemory): ChatMessage[] {
    const { turns } = session;
    const dropped: ChatMessage[] = [];

    while (turns.length >= 2) {
      const pairCount = turns.length / 2;
      const overPairs = maxHistoryPairs > 0 && pairCount > maxHistoryPairs;
      const overChars = maxHistoryChars > 0 && totalTurnChars(turns) > maxHistoryChars;
      if (!overPairs && !overChars) break;
      dropped.push(turns.shift()!, turns.shift()!);
    }

    return dropped;
  }

  /**
   * 将裁切出的对话异步折叠进 summary/facts，不阻塞流式响应结束。
   * 执行时读取当时的 session.summary/facts（链式排队后即为上一任务写入结果），与闭包中的 dropped 合并。
   */
  function enqueueFoldDropped(session: SessionMemory, dropped: ChatMessage[]): void {
    if (dropped.length === 0 || !summarizeOnTrim) return;

    session.foldChain = (session.foldChain ?? Promise.resolve()).then(async () => {
      try {
        const { summary, facts } = await foldDroppedIntoLayers(
          session.summary,
          session.facts,
          dropped,
        );
        session.summary = summary.trim() || undefined;
        session.facts = facts.trim() || undefined;
      } catch (e) {
        console.error("chat history summarize failed:", e);
      }
    });
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
      { role: "system", content: buildSystemContent(session) },
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

    const dropped = trimTurnsIfOverLimit(session);
    enqueueFoldDropped(session, dropped);
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
