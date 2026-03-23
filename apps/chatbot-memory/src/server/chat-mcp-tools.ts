import { joinUrl } from "./deepseek-client.js";
import { parseIntEnv } from "./chat-env.js";
import type { McpPool } from "./mcp.js";

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessageForTools =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

const MAX_TOOL_ROUNDS = 16;

/** DeepSeek / OpenAI 兼容接口：function.name 长度上限 */
const MAX_OPENAI_FUNCTION_NAME_LEN = 64;

function sanitizeToolNamePart(s: string): string {
  const t = s.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return t || "x";
}

/**
 * 为每个 MCP 工具生成唯一、可读、≤64 的函数名，便于模型根据名称与 description 自主选择工具。
 */
function makeOpenAiToolNames(list: Array<{ serverId: string; name: string }>): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const a = sanitizeToolNamePart(item.serverId).slice(0, 24);
    const b = sanitizeToolNamePart(item.name).slice(0, 38);
    let base = `${a}_${b}`;
    if (base.length > MAX_OPENAI_FUNCTION_NAME_LEN) {
      base = base.slice(0, MAX_OPENAI_FUNCTION_NAME_LEN);
    }
    let candidate = base;
    let n = 0;
    while (used.has(candidate)) {
      n += 1;
      const suf = `_${n}`;
      candidate = (base.slice(0, MAX_OPENAI_FUNCTION_NAME_LEN - suf.length) + suf).slice(
        0,
        MAX_OPENAI_FUNCTION_NAME_LEN,
      );
    }
    used.add(candidate);
    out.push(candidate);
  }
  return out;
}

/** 去掉 JSON Schema 里的 description，常能显著缩小体积；仍过大则退回宽松 object */
function stripSchemaDescriptions(x: unknown): unknown {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(stripSchemaDescriptions);
  const o = x as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === "description") continue;
    out[k] = stripSchemaDescriptions(v);
  }
  return out;
}

function slimParametersForApi(schema: unknown, maxBytes: number): unknown {
  if (!schema || typeof schema !== "object") {
    return { type: "object", additionalProperties: true };
  }
  const tryBytes = (s: unknown) => Buffer.byteLength(JSON.stringify(s), "utf8");
  if (tryBytes(schema) <= maxBytes) return schema;
  const stripped = stripSchemaDescriptions(schema);
  if (tryBytes(stripped) <= maxBytes) return stripped;
  return { type: "object", additionalProperties: true };
}

function clipText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}

export type ChatMcpPayloadLimits = {
  maxTools: number;
  maxParamBytesPerTool: number;
  maxDescriptionChars: number;
  maxToolResultChars: number;
  maxToolsJsonBytes: number;
  /** 整段 messages JSON 上限，避免对话过长触发 413 */
  maxContextJsonBytes: number;
};

function loadChatMcpPayloadLimits(): ChatMcpPayloadLimits {
  return {
    maxTools: Math.min(256, Math.max(1, parseIntEnv("CHAT_MCP_MAX_TOOLS", 48))),
    maxParamBytesPerTool: Math.max(256, parseIntEnv("CHAT_MCP_TOOL_PARAM_MAX_BYTES", 6144)),
    maxDescriptionChars: Math.max(80, parseIntEnv("CHAT_MCP_TOOL_DESC_MAX_CHARS", 900)),
    maxToolResultChars: Math.max(1000, parseIntEnv("CHAT_MCP_TOOL_RESULT_MAX_CHARS", 65536)),
    maxToolsJsonBytes: Math.max(50_000, parseIntEnv("CHAT_MCP_TOOLS_JSON_MAX_BYTES", 450_000)),
    maxContextJsonBytes: Math.max(100_000, parseIntEnv("CHAT_MCP_CONTEXT_MAX_JSON_BYTES", 1_200_000)),
  };
}

/** 从前往后删成对的 user/assistant，缩小整段对话 JSON，保留 system 与末尾当前 user */
function trimMessagesForByteBudget(messages: ChatMessageForTools[], maxBytes: number): ChatMessageForTools[] {
  const m = messages.map((row) => ({ ...row }));
  const size = () => Buffer.byteLength(JSON.stringify(m), "utf8");
  while (size() > maxBytes && m.length > 2) {
    if (m[0]?.role === "system" && m[1]?.role === "user" && m[2]?.role === "assistant") {
      m.splice(1, 2);
      continue;
    }
    m.splice(1, 1);
  }
  if (size() > maxBytes && m.length >= 2 && m[0]?.role === "system") {
    const u = m[1];
    if (u?.role === "user" && typeof u.content === "string" && u.content.length > 8000) {
      u.content = `${u.content.slice(0, 8000)}…\n[已截断：当前用户消息过长]`;
    }
  }
  return m;
}

/** 多轮 tool 后体积暴涨：先缩短最旧的 tool 正文，仍超限再删早期对话（就地修改） */
function squeezeMessagesForByteBudget(messages: ChatMessageForTools[], maxBytes: number): void {
  const bytes = () => Buffer.byteLength(JSON.stringify(messages), "utf8");
  let guard = 0;
  while (bytes() > maxBytes && guard++ < 2000) {
    const idx = messages.findIndex((x, i) => i > 0 && x.role === "tool");
    if (idx === -1) break;
    const row = messages[idx] as { role: "tool"; tool_call_id: string; content: string };
    const prevLen = row.content.length;
    row.content = `[已省略工具输出（原约 ${prevLen} 字符）]`;
  }
  if (bytes() > maxBytes) {
    const t = trimMessagesForByteBudget(messages, maxBytes);
    messages.length = 0;
    messages.push(...t);
  }
}

/**
 * 将 MCP 工具转为 OpenAI tools；`function.name` 为可读唯一名（≤64），`nameToRef` 用于解析模型返回的 tool_calls。
 */
function mcpListToOpenAiToolsAndMap(
  list: Awaited<ReturnType<McpPool["listTools"]>>,
  limits: ChatMcpPayloadLimits,
): {
  tools: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }>;
  nameToRef: Map<string, { serverId: string; toolName: string }>;
} {
  const sliced = list.slice(0, limits.maxTools);
  const displayNames = makeOpenAiToolNames(sliced.map((t) => ({ serverId: t.serverId, name: t.name })));
  const nameToRef = new Map<string, { serverId: string; toolName: string }>();
  const tools = sliced.map((t, i) => {
    const name = displayNames[i]!;
    nameToRef.set(name, { serverId: t.serverId, toolName: t.name });
    const rawDesc = (t.description ?? "").trim() || `MCP tool ${t.serverId}/${t.name}`;
    const description = clipText(rawDesc, limits.maxDescriptionChars);
    const baseSchema =
      t.inputSchema && typeof t.inputSchema === "object"
        ? t.inputSchema
        : { type: "object", properties: {}, additionalProperties: true };
    const parameters = slimParametersForApi(baseSchema, limits.maxParamBytesPerTool);
    return {
      type: "function" as const,
      function: {
        name,
        description,
        parameters,
      },
    };
  });

  let curTools = tools;
  let jsonBytes = Buffer.byteLength(JSON.stringify(curTools), "utf8");

  while (jsonBytes > limits.maxToolsJsonBytes && curTools.length > 1) {
    const n = Math.max(1, Math.floor(curTools.length / 2));
    curTools = curTools.slice(0, n);
    jsonBytes = Buffer.byteLength(JSON.stringify(curTools), "utf8");
    console.warn(`[MCP] 工具定义约 ${jsonBytes} bytes（目标 ≤${limits.maxToolsJsonBytes}），已缩减为前 ${curTools.length} 个工具`);
  }

  if (jsonBytes > limits.maxToolsJsonBytes) {
    for (const x of curTools) {
      x.function.parameters = { type: "object", additionalProperties: true };
    }
    jsonBytes = Buffer.byteLength(JSON.stringify(curTools), "utf8");
    console.warn(`[MCP] 已将全部工具 parameters 压为最小 object（约 ${jsonBytes} bytes）`);
  }

  if (jsonBytes > limits.maxToolsJsonBytes) {
    console.warn(
      `[MCP] 工具 JSON 仍约 ${jsonBytes} bytes，若仍报 413 请降低 CHAT_MCP_MAX_TOOLS 或 CHAT_MCP_TOOL_PARAM_MAX_BYTES`,
    );
  }

  return { tools: curTools, nameToRef };
}

function toolResultToAssistantString(
  result: Awaited<ReturnType<McpPool["callTool"]>>,
  maxChars: number,
): string {
  let s: string;
  try {
    s = JSON.stringify(result);
  } catch {
    s = String(result);
  }
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n\n[已截断：工具返回约 ${s.length} 字符，仅保留前 ${maxChars} 字符]`;
}

async function chatCompletionNonStream(options: {
  chatUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  messages: ChatMessageForTools[];
  tools: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }>;
}): Promise<{
  message: { content?: string | null; tool_calls?: OpenAiToolCall[] };
}> {
  const { chatUrl, apiKey, model, temperature, messages, tools } = options;
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
      tools,
      /** 由模型根据用户意图与工具说明自主选择是否调用、调用哪一个（及参数） */
      tool_choice: "auto",
      stream: false,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${errText}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[];
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw new Error("模型返回无 message");
  return { message };
}

/**
 * 在已组好的 messages（含 system + 历史 + 当前 user）上跑 MCP 工具循环，最后流式输出助手正文。
 * 返回完整助手文本（供写入会话记忆）。
 */
export async function* streamChatWithMcpTools(options: {
  mcp: McpPool;
  chatBaseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** 已含 system、历史 turns、本轮 user */
  messages: ChatMessageForTools[];
}): AsyncGenerator<string, string> {
  const { mcp, chatBaseUrl, apiKey, model, temperature } = options;
  const limits = loadChatMcpPayloadLimits();
  let messages: ChatMessageForTools[] = options.messages.map((m) => ({ ...m }));
  messages = trimMessagesForByteBudget(messages, limits.maxContextJsonBytes);
  if (messages[0]?.role === "system" && typeof messages[0].content === "string") {
    const hint =
      "\n\n【工具】当用户问题需要外部能力时，请从本轮提供的函数（tools）中**自行判断**应调用哪一个或哪几个，并填入正确参数；不要编造不存在的工具名。";
    if (!messages[0].content.includes("【工具】")) {
      messages[0] = { ...messages[0], content: messages[0].content + hint };
    }
  }
  const chatUrl = joinUrl(chatBaseUrl, "/v1/chat/completions");

  const { tools: toolDefs, nameToRef } = mcpListToOpenAiToolsAndMap(await mcp.listTools(), limits);
  if (toolDefs.length === 0) {
    throw new Error("MCP 未返回可用工具");
  }

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    squeezeMessagesForByteBudget(messages, limits.maxContextJsonBytes);
    const { message } = await chatCompletionNonStream({
      chatUrl,
      apiKey,
      model,
      temperature,
      messages,
      tools: toolDefs,
    });

    const calls = message.tool_calls?.filter((c) => c.type === "function");
    if (calls?.length) {
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: calls,
      });
      for (const tc of calls) {
        const ref = nameToRef.get(tc.function.name);
        let toolText: string;
        if (!ref) {
          toolText = JSON.stringify({ isError: true, error: `未知工具名: ${tc.function.name}` });
        } else {
          let args: Record<string, unknown> = {};
          try {
            const raw = tc.function.arguments?.trim();
            if (raw) args = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            toolText = JSON.stringify({ isError: true, error: "工具 arguments 不是合法 JSON" });
            messages.push({ role: "tool", tool_call_id: tc.id, content: toolText });
            continue;
          }
          try {
            const result = await mcp.callTool(ref.serverId, ref.toolName, args);
            toolText = toolResultToAssistantString(result, limits.maxToolResultChars);
          } catch (e) {
            toolText = JSON.stringify({
              isError: true,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: toolText });
      }
      continue;
    }

    const text = typeof message.content === "string" ? message.content : "";
    for (let i = 0; i < text.length; i += 64) {
      yield text.slice(i, i + 64);
    }
    return text;
  }

  throw new Error(`工具调用超过 ${MAX_TOOL_ROUNDS} 轮上限`);
}
