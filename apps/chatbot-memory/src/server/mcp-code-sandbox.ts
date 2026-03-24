import vm from "node:vm";
import type { McpPool } from "./mcp.js";

function cloneJsonSafe(x: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    return x;
  }
}

export type McpSandboxOptions = {
  code: string;
  mcp: McpPool;
  nameToRef: Map<string, { serverId: string; toolName: string }>;
  maxMs: number;
  maxCalls: number;
  maxToolResultChars: number;
};

export type McpSandboxResult = {
  ok: boolean;
  returnValue?: unknown;
  error?: string;
  consoleLines: string[];
  callCount: number;
};

/**
 * 在受限 vm 上下文中执行用户代码：仅暴露 `mcp`、`__call_mcp__`、安全子集全局；MCP 调用转发到 McpPool。
 */
export async function runMcpSandboxCode(opts: McpSandboxOptions): Promise<McpSandboxResult> {
  const consoleLines: string[] = [];
  const pushLog = (level: string, args: unknown[]) => {
    const parts = args.map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    });
    const line = `[${level}] ${parts.join(" ")}`;
    consoleLines.push(line.length > 4000 ? `${line.slice(0, 4000)}…` : line);
  };

  let callCount = 0;

  const dispatch = async (toolKey: string, args: object): Promise<unknown> => {
    if (callCount >= opts.maxCalls) {
      throw new Error(`MCP 调用次数超过上限（${opts.maxCalls}）`);
    }
    const ref = opts.nameToRef.get(toolKey);
    if (!ref) {
      throw new Error(`未知工具键: ${toolKey}`);
    }
    callCount += 1;
    const raw = await opts.mcp.callTool(ref.serverId, ref.toolName, args as Record<string, unknown>);
    const cloned = cloneJsonSafe(raw) as unknown;
    const s = JSON.stringify(cloned);
    if (s.length > opts.maxToolResultChars) {
      return {
        _mcpTruncated: true,
        _approxChars: s.length,
        preview: s.slice(0, opts.maxToolResultChars),
      };
    }
    return cloned;
  };

  const mcpObj: Record<string, (args: object) => Promise<unknown>> = {};
  for (const key of opts.nameToRef.keys()) {
    mcpObj[key] = (args: object) => dispatch(key, args);
  }

  const sandbox: Record<string, unknown> = {
    __call_mcp__: dispatch,
    mcp: mcpObj,
    console: {
      log: (...a: unknown[]) => pushLog("log", a),
      error: (...a: unknown[]) => pushLog("error", a),
      warn: (...a: unknown[]) => pushLog("warn", a),
      info: (...a: unknown[]) => pushLog("info", a),
    },
    JSON,
    Math,
    Date,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
  };

  const ctx = vm.createContext(sandbox);

  const wrapped = `(async () => {\n${opts.code}\n})();`;
  const script = new vm.Script(wrapped, { filename: "user-mcp-code.mjs" });

  const runPromise = script.runInContext(ctx) as Promise<unknown>;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      rej(new Error(`代码执行超时（${opts.maxMs}ms）`));
    }, opts.maxMs);
  });

  try {
    const ret = await Promise.race([runPromise, timeoutPromise]);
    return { ok: true, returnValue: ret, consoleLines, callCount };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      consoleLines,
      callCount,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
