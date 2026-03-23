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

/**
 * 单轮用户消息内，「模型请求工具 → 执行 → 把结果写回再请求」的最大轮数。
 * 不是遍历 MCP 上的全部工具；每轮仅执行当次响应里出现的 tool_calls。
 */
const MAX_TOOL_ROUNDS = 16;

/** DeepSeek 要求 tools[].function.name 不超过此长度（与 OpenAI 兼容接口一致） */
const MAX_OPENAI_FUNCTION_NAME_LEN = 64;

function sanitizeToolNamePart(s: string): string {
  const t = s.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return t || "x";
}

/** 生成 OpenAI tools 用的 function.name：唯一、可读、≤MAX_OPENAI_FUNCTION_NAME_LEN，便于模型区分 */
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

/** 递归去掉 JSON Schema 中的 description，以减小体积（与 slimParametersForApi 搭配） */
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
  /** 整段 messages 序列化后的字节上限，防止上下文过大触发 413 */
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

/** 缩小 messages：优先删掉最早的一对 user/assistant，保留 system 与最后一条 user */
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

/** 工具轮次多了以后 messages 膨胀：先替换最旧的 tool 消息正文为占位，仍超限再走 trimMessagesForByteBudget（就地修改） */
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
 * 把 listTools() 结果转成请求体里的 tools[]，并建 Map：OpenAI function.name → 真实 MCP (serverId, toolName)。
 * 若 tools 总 JSON 过大，会裁减列表或压扁 parameters（见 CHAT_MCP_*）。
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
      // tool_choice=auto：是否调用工具、调用哪一个、参数为何，均由模型决定；非遍历执行全部 tools
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
 * 使用 DeepSeek Function Calling 驱动 MCP：反复请求直到模型不再返回 tool_calls，再产出最终回复。
 *
 * - listTools 仅用于把「工具定义」塞进 tools，不会逐个执行。
 * - 每轮仅对响应中的 tool_calls 调用 mcp.callTool；无 tool_calls 时 yield 正文并结束。
 */
export async function* streamChatWithMcpTools(options: {
  mcp: McpPool;
  chatBaseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** 已含 system、历史 user/assistant、本轮 user（工具轮次中会就地追加 assistant/tool） */
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
    // 每一轮：一次 chat/completions；若有 tool_calls 则执行后 continue，否则 yield 正文并 return
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

  throw new Error(`模型与工具多轮往返超过 ${MAX_TOOL_ROUNDS} 轮上限（非 MCP 工具总数）`);
}
