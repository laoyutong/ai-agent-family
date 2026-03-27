/// <reference types="node" />
/**
 * 仅由 `child_process.fork` 启动：环境变量 `CHAT_MCP_SANDBOX_CHILD=1`。
 * 在独立子进程中执行模型生成的代码 + `node:vm`，通过 IPC 将 MCP 调用交给父进程；
 * 即使发生 vm 逃逸，也与主进程（API 密钥、MCP 凭证等）隔离。
 */
import vm from "node:vm";
import process from "node:process";

type RunMessage = {
  type: "run";
  runId: string;
  code: string;
  toolKeys: string[];
};

type McpResultMsg =
  | { type: "mcpResult"; seq: number; ok: true; result: unknown }
  | { type: "mcpResult"; seq: number; ok: false; error: string };

type FromChild =
  | { type: "mcpCall"; seq: number; toolKey: string; args: Record<string, unknown> }
  | { type: "done"; ok: true; returnValue?: unknown; consoleLines: string[] }
  | { type: "done"; ok: false; error: string; consoleLines: string[] };

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let callSeq = 0;

function sendToParent(msg: FromChild): void {
  if (typeof process.send !== "function") return;
  process.send(msg);
}

function waitMcpResult(seq: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    pending.set(seq, { resolve, reject });
  });
}

function startMcpSandboxChild(): void {
  process.on("message", (msg: unknown) => {
    void handleMessage(msg);
  });
}

async function handleMessage(msg: unknown): Promise<void> {
  if (!msg || typeof msg !== "object") return;

  const m = msg as RunMessage | McpResultMsg;
  if (m.type === "mcpResult") {
    const p = pending.get(m.seq);
    if (!p) return;
    pending.delete(m.seq);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error));
    return;
  }

  if (m.type !== "run") return;

  const run = m as RunMessage;
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
    consoleLines.push(line);
  };

  const dispatch = async (toolKey: string, args: object): Promise<unknown> => {
    const seq = ++callSeq;
    sendToParent({ type: "mcpCall", seq, toolKey, args: args as Record<string, unknown> });
    return waitMcpResult(seq);
  };

  const mcpObj: Record<string, (args: object) => Promise<unknown>> = {};
  for (const key of run.toolKeys) {
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

  try {
    const ctx = vm.createContext(sandbox);
    const wrapped = `(async () => {\n${run.code}\n})();`;
    const script = new vm.Script(wrapped, { filename: "user-mcp-code.mjs" });
    const runPromise = script.runInContext(ctx) as Promise<unknown>;
    const ret = await runPromise;
    sendToParent({ type: "done", ok: true, returnValue: ret, consoleLines });
  } catch (e) {
    sendToParent({
      type: "done",
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      consoleLines,
    });
  } finally {
    pending.clear();
  }
}

if (process.env.CHAT_MCP_SANDBOX_CHILD === "1") {
  startMcpSandboxChild();
}

export {};
