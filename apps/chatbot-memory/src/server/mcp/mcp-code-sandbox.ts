import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { parseEnvBool, parseIntEnv } from "../config/chat-env.js";
import type { McpPool } from "./mcp.js";

/** 子进程不应继承的敏感/可滥用环境变量名模式（仅块级删除键名，不记录值） */
const SANDBOX_CHILD_ENV_BLOCKLIST: RegExp[] = [
  /^DEEPSEEK_/,
  /^OPENAI_/,
  /^ANTHROPIC_/,
  /^AZURE_/,
  /^GOOGLE_/,
  /^MCP_SERVERS$/,
  /API_KEY$/i,
  /_SECRET$/i,
  /_TOKEN$/i,
  /PASSWORD/i,
  /PRIVATE_KEY/i,
];

function envForSandboxChild(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    let block = false;
    for (const re of SANDBOX_CHILD_ENV_BLOCKLIST) {
      if (re.test(k)) {
        block = true;
        break;
      }
    }
    if (!block) out[k] = v;
  }
  out.CHAT_MCP_SANDBOX_CHILD = "1";
  delete out.NODE_OPTIONS;
  return out;
}

function resolveSandboxChildEntry(): { entry: string; execArgv: string[] } {
  const dir = dirname(fileURLToPath(import.meta.url));
  const compiled = join(dir, "mcp-sandbox-child.js");
  if (existsSync(compiled)) {
    return { entry: compiled, execArgv: [] };
  }
  const source = join(dir, "mcp-sandbox-child.ts");
  if (existsSync(source)) {
    return { entry: source, execArgv: ["--import", "tsx"] };
  }
  throw new Error("mcp-sandbox-child entry not found (.js or .ts)");
}

/** 服务端日志：便于排查沙盒实际执行的代码（grep `[MCP] sandbox:code`） */
export function logMcpSandboxCode(round: number, code: string): void {
  console.log(`[MCP] sandbox:code`, { round, chars: code.length, body: code });
}

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
};

export type McpSandboxResult = {
  ok: boolean;
  returnValue?: unknown;
  error?: string;
  consoleLines: string[];
  callCount: number;
};

type ChildMcpCall = {
  type: "mcpCall";
  seq: number;
  toolKey: string;
  args: Record<string, unknown>;
};

type ChildDone =
  | { type: "done"; ok: true; returnValue?: unknown; consoleLines: string[] }
  | { type: "done"; ok: false; error: string; consoleLines: string[] };

function killChild(child: ChildProcess): void {
  try {
    if (!child.killed) child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  const force = setTimeout(() => {
    try {
      if (!child.killed) child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }, 750);
  force.unref();
}

/**
 * 复用 fork 子进程：限制同时占用数 ≤ max，空闲进程放回池中供下一次 `run`。
 * `CHAT_MCP_SANDBOX_POOL_SIZE=0` 关闭池（每次执行仍 fork+结束即杀，与旧行为一致）。
 */
class SandboxChildPool {
  private readonly max: number;
  private readonly entry: string;
  private readonly execArgv: string[];
  private idle: ChildProcess[] = [];
  private readonly busy = new Set<ChildProcess>();
  private waiters: Array<() => void> = [];

  constructor(max: number, entry: string, execArgv: string[]) {
    this.max = max;
    this.entry = entry;
    this.execArgv = execArgv;
  }

  private spawn(): ChildProcess {
    const child = fork(this.entry, [], {
      execArgv: this.execArgv,
      env: envForSandboxChild(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.on("exit", () => {
      this.busy.delete(child);
      this.idle = this.idle.filter((c) => c !== child);
      this.wakeOneWaiter();
    });
    return child;
  }

  private wakeOneWaiter(): void {
    const w = this.waiters.shift();
    if (w) w();
  }

  async acquire(): Promise<ChildProcess> {
    for (;;) {
      if (this.idle.length > 0) {
        const c = this.idle.pop()!;
        this.busy.add(c);
        return c;
      }
      if (this.busy.size < this.max) {
        const c = this.spawn();
        this.busy.add(c);
        return c;
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
  }

  /** 成功执行完一轮且子进程仍健康时归还池中；否则杀掉子进程（异常/超时/执行失败）。 */
  release(child: ChildProcess, healthy: boolean): void {
    this.busy.delete(child);
    if (healthy) {
      this.idle.push(child);
      this.wakeOneWaiter();
    } else {
      killChild(child);
    }
  }
}

let sandboxPool: SandboxChildPool | null = null;

function getSandboxPool(entry: string, execArgv: string[]): SandboxChildPool | null {
  const size = parseIntEnv("CHAT_MCP_SANDBOX_POOL_SIZE", 4);
  if (size <= 0) return null;
  if (!sandboxPool) {
    sandboxPool = new SandboxChildPool(size, entry, execArgv);
  }
  return sandboxPool;
}

/**
 * 默认：在子进程中执行 vm（进程隔离 + 剥离敏感 env）；逃逸仅限子进程。
 * 设 `CHAT_MCP_SANDBOX_IN_PROCESS=true` 时回退为同进程 vm（不推荐，仅调试用）。
 */
export async function runMcpSandboxCode(opts: McpSandboxOptions): Promise<McpSandboxResult> {
  if (parseEnvBool("CHAT_MCP_SANDBOX_IN_PROCESS", false)) {
    return runMcpSandboxCodeInProcess(opts);
  }
  const { entry, execArgv } = resolveSandboxChildEntry();
  const pool = getSandboxPool(entry, execArgv);
  if (pool) {
    const child = await pool.acquire();
    return runOneSandboxSession(child, opts, (healthy) => pool!.release(child, healthy));
  }
  const child = fork(entry, [], {
    execArgv,
    env: envForSandboxChild(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  return runOneSandboxSession(child, opts, () => killChild(child));
}

/**
 * 单次 user 代码执行：结束后调用 `onEnd(healthy)` — 池化时 healthy=true 归还子进程，否则销毁。
 */
function runOneSandboxSession(
  child: ChildProcess,
  opts: McpSandboxOptions,
  onEnd: (healthy: boolean) => void,
): Promise<McpSandboxResult> {
  let callCount = 0;

  let stderrBuf = "";
  child.stderr?.setEncoding("utf8");
  const onStderr = (c: string) => {
    if (stderrBuf.length < 8000) stderrBuf += c;
  };
  child.stderr?.on("data", onStderr);

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const detachRunListeners = () => {
      child.off("message", onMessage);
      child.off("error", onChildError);
      child.off("exit", onChildExit);
      child.stderr?.off("data", onStderr);
    };
    const finish = (r: McpSandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachRunListeners();
      const healthy = r.ok === true && r.error === undefined;
      onEnd(healthy);
      resolve(r);
    };
    timer = setTimeout(() => {
      finish({
        ok: false,
        error: `代码执行超时（${opts.maxMs}ms）`,
        consoleLines: [],
        callCount,
      });
    }, opts.maxMs);

    const onChildError = (err: Error) => {
      finish({
        ok: false,
        error: err.message,
        consoleLines: [],
        callCount,
      });
    };

    const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      const hint = stderrBuf.trim().length > 0 ? ` 子进程 stderr: ${stderrBuf.trim()}` : "";
      finish({
        ok: false,
        error: signal
          ? `沙盒子进程被终止（${signal}）${hint}`
          : `沙盒子进程异常退出（${code ?? "?"}）${hint}`,
        consoleLines: [],
        callCount,
      });
    };

    const onMessage = async (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as ChildMcpCall | ChildDone;

      if (m.type === "mcpCall" && typeof m.seq === "number" && typeof m.toolKey === "string") {
        const args =
          m.args !== undefined && typeof m.args === "object" && !Array.isArray(m.args)
            ? (m.args as Record<string, unknown>)
            : {};
        try {
          if (callCount >= opts.maxCalls) {
            child.send({
              type: "mcpResult",
              seq: m.seq,
              ok: false,
              error: `MCP 调用次数超过上限（${opts.maxCalls}）`,
            });
            return;
          }
          const ref = opts.nameToRef.get(m.toolKey);
          if (!ref) {
            child.send({
              type: "mcpResult",
              seq: m.seq,
              ok: false,
              error: `未知工具键: ${m.toolKey}`,
            });
            return;
          }
          callCount += 1;
          const raw = await opts.mcp.callTool(ref.serverId, ref.toolName, args);
          const cloned = cloneJsonSafe(raw) as unknown;
          child.send({ type: "mcpResult", seq: m.seq, ok: true, result: cloned });
        } catch (e) {
          child.send({
            type: "mcpResult",
            seq: m.seq,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }

      if (m.type === "done") {
        const d = m as ChildDone;
        finish({
          ok: d.ok,
          returnValue: d.ok ? d.returnValue : undefined,
          error: d.ok ? undefined : d.error,
          consoleLines: d.consoleLines,
          callCount,
        });
      }
    };

    child.on("message", onMessage);
    child.on("error", onChildError);
    child.on("exit", onChildExit);

    child.send({
      type: "run",
      runId: randomUUID(),
      code: opts.code,
      toolKeys: [...opts.nameToRef.keys()],
    });
  });
}

/**
 * 同进程 vm（旧路径）：仍存在 AsyncFunction/构造器逃逸等同进程风险，仅建议本机调试时开启。
 */
async function runMcpSandboxCodeInProcess(opts: McpSandboxOptions): Promise<McpSandboxResult> {
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
    return cloneJsonSafe(raw) as unknown;
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

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      rej(new Error(`代码执行超时（${opts.maxMs}ms）`));
    }, opts.maxMs);
  });

  try {
    const runPromise = script.runInContext(ctx) as Promise<unknown>;
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
