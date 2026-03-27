import type { ChatMcpPayloadLimits } from "./chat-mcp-limits.js";
import type { McpPool } from "./mcp.js";

/** 与 OpenAI function.name 一致：唯一、可读、≤64，便于与历史逻辑对齐 */
const MAX_OPENAI_FUNCTION_NAME_LEN = 64;

function sanitizeToolNamePart(s: string): string {
  const t = s.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return t || "x";
}

/** 生成唯一工具键（亦作 `mcp` 上的属性名基础） */
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

function isValidJsIdentifier(s: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s);
}

/** 对象字面量中的属性名：合法标识符则裸写，否则 JSON 引号 */
function escapePropertyName(s: string): string {
  return isValidJsIdentifier(s) ? s : JSON.stringify(s);
}

/** 递归去掉 JSON Schema 中的 description，减小体积 */
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

function slimSchemaForTs(schema: unknown, maxBytes: number): unknown {
  if (!schema || typeof schema !== "object") {
    return { type: "object", additionalProperties: true };
  }
  const tryBytes = (s: unknown) => Buffer.byteLength(JSON.stringify(s), "utf8");
  if (tryBytes(schema) <= maxBytes) return schema;
  const stripped = stripSchemaDescriptions(schema);
  if (tryBytes(stripped) <= maxBytes) return stripped;
  return { type: "object", additionalProperties: true };
}

/**
 * 将 JSON Schema 转为简化的 TypeScript 式类型占位（仅常见子集；过大则退化为 Record<string, unknown>）。
 */
function jsonSchemaToTsLike(schema: unknown, maxBytes = 2048): string {
  const slim = slimSchemaForTs(schema, maxBytes);
  const walk = (x: unknown, depth: number): string => {
    if (depth > 8) return "unknown";
    if (x === null || typeof x !== "object") return "unknown";
    if (Array.isArray(x)) return "unknown";
    const o = x as Record<string, unknown>;
    const t = o.type;
    if (t === "string") return "string";
    if (t === "number" || t === "integer") return "number";
    if (t === "boolean") return "boolean";
    if (t === "array") {
      const items = o.items;
      return `Array<${walk(items, depth + 1)}>`;
    }
    if (t === "object") {
      const props = o.properties;
      if (!props || typeof props !== "object" || Array.isArray(props)) {
        return o.additionalProperties === false ? "{}" : "Record<string, unknown>";
      }
      const req = new Set(
        Array.isArray(o.required) ? o.required.filter((x): x is string => typeof x === "string") : [],
      );
      const parts: string[] = [];
      for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
        const opt = req.has(k) ? "" : "?";
        parts.push(`${JSON.stringify(k)}${opt}: ${walk(v, depth + 1)}`);
      }
      return `{ ${parts.join("; ")} }`;
    }
    return "Record<string, unknown>";
  };
  try {
    return walk(slim, 0);
  } catch {
    return "Record<string, unknown>";
  }
}

type McpFacadeBuild = {
  facadeText: string;
  nameToRef: Map<string, { serverId: string; toolName: string }>;
};

/**
 * 从 listTools 结果生成发给模型的 `mcp` / `__call_mcp__` 说明文本，并建立 toolKey → MCP 映射。
 */
export function buildMcpFacadeFromTools(
  list: Awaited<ReturnType<McpPool["listTools"]>>,
  limits: ChatMcpPayloadLimits,
): McpFacadeBuild {
  const sliced = list.slice(0, limits.maxTools);
  const nameToRef = new Map<string, { serverId: string; toolName: string }>();

  const buildText = (): string => {
    const keys = makeOpenAiToolNames(sliced.map((t) => ({ serverId: t.serverId, name: t.name })));
    nameToRef.clear();
    const lines: string[] = [
      "/**",
      " * 运行时由服务端注入；此处为类型与调用约定说明。",
      " * 代码里请只用 await __call_mcp__(与各条目 => 右侧 __call_mcp__(\"…\", args) 的引号内字符串逐字相同, args)；勿写 mcp.xxx()；勿把键中 - 改成 _。",
      " */",
      "declare function __call_mcp__(toolKey: string, args: object): Promise<unknown>;",
      "",
      "export const mcp = {",
    ];
    for (let i = 0; i < sliced.length; i++) {
      const t = sliced[i]!;
      const key = keys[i]!;
      nameToRef.set(key, { serverId: t.serverId, toolName: t.name });
      const desc = ((t.description ?? "").trim() || `MCP tool ${t.serverId}/${t.name}`).replace(/\*\//g, "*\\/");
      const baseSchema =
        t.inputSchema && typeof t.inputSchema === "object"
          ? t.inputSchema
          : { type: "object", properties: {}, additionalProperties: true };
      const argsTs = jsonSchemaToTsLike(baseSchema, limits.maxParamBytesPerTool);
      const prop = escapePropertyName(key);
      lines.push(`  /** ${desc} */`);
      lines.push(
        `  ${prop}: async (args: ${argsTs}): Promise<unknown> => __call_mcp__(${JSON.stringify(key)}, args),`,
      );
    }
    lines.push("};");
    return lines.join("\n");
  };

  const facadeText = buildText();

  return { facadeText, nameToRef };
}

/** 从模型回复中提取第一个 fenced 代码块（javascript/typescript） */
export function extractFirstFencedCodeBlock(text: string): string | null {
  const m = text.match(/```(?:typescript|javascript|ts|js)?\s*\r?\n([\s\S]*?)```/i);
  const body = m?.[1]?.trim();
  return body && body.length > 0 ? body : null;
}
