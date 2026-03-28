import "./load-env.js";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { stringifyUnknownForLog } from "../util/log-preview.js";

const CLIENT = { name: "chatbot-memory", version: "0.0.0" };

/** MCP callTool 返回写入日志时的最大字符数（超长省略） */
const MCP_CALL_TOOL_RESULT_LOG_MAX = 8_000;

/** 统一 MCP 服务侧日志前缀，便于 grep `[MCP]` 看完整流程 */
function mcpLog(phase: string, detail: Record<string, unknown> = {}) {
  console.log(`[MCP] ${phase}`, detail);
}

type McpCfg =
  | { id: string; transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { id: string; transport: "http"; url: string };

/**
 * 将 `MCP_SERVERS` 中的 `${VAR}` 替换为 `process.env.VAR`（便于目录等由单独环境变量填写，避免写死在 JSON 里）。
 */
function expandEnvRefs(s: string, ctx: string): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name: string) => {
    const v = process.env[name];
    if (v === undefined || v === "") {
      throw new Error(`${ctx}：环境变量「${name}」未设置或为空，无法替换 ${full}`);
    }
    return v;
  });
}

function loadMcpServerConfigs(): McpCfg[] {
  const raw = process.env.MCP_SERVERS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MCP_SERVERS 不是合法 JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("MCP_SERVERS 须为 JSON 数组");
  const out: McpCfg[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const o = parsed[i];
    if (o === null || typeof o !== "object" || Array.isArray(o)) {
      throw new Error(`MCP_SERVERS[${i}] 须为对象`);
    }
    const r = o as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id) throw new Error(`MCP_SERVERS[${i}] 缺少有效 id`);
    const t = r.transport;
    if (t === "stdio") {
      const commandRaw = typeof r.command === "string" ? r.command.trim() : "";
      if (!commandRaw) throw new Error(`MCP「${id}」stdio 须配置 command`);
      const command = expandEnvRefs(commandRaw, `MCP「${id}」command`);
      let env: Record<string, string> | undefined;
      if (r.env !== undefined) {
        if (r.env === null || typeof r.env !== "object" || Array.isArray(r.env)) {
          throw new Error(`MCP「${id}」env 须为对象`);
        }
        env = {};
        for (const [k, v] of Object.entries(r.env)) {
          if (typeof v === "string") env[k] = expandEnvRefs(v, `MCP「${id}」env.${k}`);
        }
      }
      const args = Array.isArray(r.args)
        ? r.args.map((a, j) => expandEnvRefs(String(a), `MCP「${id}」args[${j}]`))
        : undefined;
      const cwdRaw = typeof r.cwd === "string" && r.cwd.trim() ? r.cwd.trim() : undefined;
      const cwd = cwdRaw ? expandEnvRefs(cwdRaw, `MCP「${id}」cwd`) : undefined;
      out.push({
        id,
        transport: "stdio",
        command,
        args,
        env,
        cwd,
      });
    } else if (t === "http") {
      const urlRaw = typeof r.url === "string" ? r.url.trim() : "";
      if (!urlRaw) throw new Error(`MCP「${id}」http 须配置 url`);
      const url = expandEnvRefs(urlRaw, `MCP「${id}」url`);
      out.push({ id, transport: "http", url });
    } else {
      throw new Error(`MCP「${id}」transport 须为 "stdio" 或 "http"`);
    }
  }
  return out;
}

function describeCfg(cfg: McpCfg): Record<string, unknown> {
  if (cfg.transport === "stdio") {
    const argLine = cfg.args?.length ? cfg.args.join(" ") : "";
    return {
      transport: "stdio",
      command: cfg.command,
      argsPreview: argLine || undefined,
      cwd: cfg.cwd,
      hasEnv: !!cfg.env,
      envKeys: cfg.env ? Object.keys(cfg.env).length : 0,
    };
  }
  return { transport: "http", url: cfg.url };
}

async function connectClient(cfg: McpCfg): Promise<Client> {
  if (cfg.transport === "stdio") {
    const c = new Client(CLIENT);
    await c.connect(
      new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        cwd: cfg.cwd,
      }),
    );
    return c;
  }
  const c = new Client(CLIENT);
  await c.connect(new StreamableHTTPClientTransport(new URL(cfg.url)));
  return c;
}

export type McpPool = {
  readonly configured: boolean;
  getStatus(): Array<{
    id: string;
    transport: "stdio" | "http";
    connected: boolean;
    error?: string;
    instructions?: string;
  }>;
  listTools(): Promise<Array<{ serverId: string; name: string; description?: string; inputSchema: unknown }>>;
  callTool(serverId: string, name: string, args?: Record<string, unknown>): Promise<Awaited<ReturnType<Client["callTool"]>>>;
  close(): Promise<void>;
};

export async function createMcpPool(): Promise<McpPool> {
  let configs: McpCfg[];
  try {
    configs = loadMcpServerConfigs();
  } catch (e) {
    throw new Error(`MCP 配置错误: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (configs.length === 0) {
    mcpLog("config", { step: "skip", reason: "MCP_SERVERS 未设置或为空" });
  } else {
    mcpLog("config", {
      step: "loaded",
      count: configs.length,
      ids: configs.map((c) => c.id).join(","),
    });
    for (const cfg of configs) {
      mcpLog("config:entry", { id: cfg.id, ...describeCfg(cfg) });
    }
  }

  type Entry = { id: string; client: Client };
  const entries: Entry[] = [];
  const errors = new Map<string, string>();

  for (const cfg of configs) {
    mcpLog("connect:start", { id: cfg.id, ...describeCfg(cfg) });
    const t0 = performance.now();
    try {
      const client = await connectClient(cfg);
      const ms = Math.round(performance.now() - t0);
      const instructions = client.getInstructions();
      mcpLog("connect:ok", {
        id: cfg.id,
        ms,
        instructionsChars: instructions?.length ?? 0,
      });
      if (instructions?.trim()) {
        mcpLog("connect:instructions", {
          id: cfg.id,
          preview: instructions,
        });
      }
      entries.push({ id: cfg.id, client });
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      const msg = e instanceof Error ? e.message : String(e);
      errors.set(cfg.id, msg);
      mcpLog("connect:fail", { id: cfg.id, ms, error: msg });
      console.error(`[MCP] 连接失败「${cfg.id}」`, e);
    }
  }

  if (configs.length > 0) {
    mcpLog("pool:ready", {
      ok: entries.length,
      fail: errors.size,
      total: configs.length,
    });
  }

  const configured = configs.length > 0;

  return {
    configured,
    getStatus: () =>
      configs.map((cfg) => {
        const e = entries.find((x) => x.id === cfg.id);
        return {
          id: cfg.id,
          transport: cfg.transport,
          connected: !!e,
          error: e ? undefined : errors.get(cfg.id),
          instructions: e?.client.getInstructions(),
        };
      }),
    listTools: async () => {
      mcpLog("listTools:start", { servers: entries.length });
      const t0 = performance.now();
      const out: Array<{ serverId: string; name: string; description?: string; inputSchema: unknown }> = [];
      for (const { id, client } of entries) {
        const t1 = performance.now();
        let pageIdx = 0;
        let countForServer = 0;
        let cursor: string | undefined;
        for (;;) {
          pageIdx += 1;
          const page = await client.listTools(cursor ? { cursor } : {});
          countForServer += page.tools.length;
          for (const t of page.tools) {
            out.push({ serverId: id, name: t.name, description: t.description, inputSchema: t.inputSchema });
          }
          mcpLog("listTools:page", {
            serverId: id,
            page: pageIdx,
            batch: page.tools.length,
            hasMore: !!page.nextCursor,
          });
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        mcpLog("listTools:serverDone", {
          serverId: id,
          tools: countForServer,
          ms: Math.round(performance.now() - t1),
        });
      }
      mcpLog("listTools:done", {
        totalTools: out.length,
        ms: Math.round(performance.now() - t0),
      });
      return out;
    },
    callTool: async (serverId, name, args) => {
      const e = entries.find((x) => x.id === serverId);
      if (!e) {
        mcpLog("callTool:fail", { serverId, name, error: "not_connected_or_missing" });
        throw new Error(`未找到已连接的 MCP 服务: ${serverId}`);
      }
      const argStr = JSON.stringify(args ?? {});
      mcpLog("callTool:start", {
        serverId,
        name,
        argKeys: args ? Object.keys(args).join(",") : "",
        argBytes: Buffer.byteLength(argStr, "utf8"),
      });
      const t0 = performance.now();
      try {
        const result = await e.client.callTool({ name, arguments: args ?? {} });
        const ms = Math.round(performance.now() - t0);
        const err =
          result && typeof result === "object" && "isError" in result && result.isError === true;
        let rawLen = 0;
        try {
          rawLen = JSON.stringify(result).length;
        } catch {
          rawLen = -1;
        }
        mcpLog("callTool:done", {
          serverId,
          name,
          ms,
          isError: err,
          resultApproxChars: rawLen,
          resultPreview: stringifyUnknownForLog(result, MCP_CALL_TOOL_RESULT_LOG_MAX),
        });
        return result;
      } catch (err) {
        mcpLog("callTool:fail", {
          serverId,
          name,
          ms: Math.round(performance.now() - t0),
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    close: async () => {
      const n = entries.length;
      if (n === 0) {
        mcpLog("close", { step: "skip", reason: "无活跃连接" });
        return;
      }
      mcpLog("close:start", { connections: n });
      for (const { id, client } of entries.splice(0)) {
        try {
          await client.close();
          mcpLog("close:ok", { id });
        } catch (e) {
          mcpLog("close:fail", {
            id,
            error: e instanceof Error ? e.message : String(e),
          });
          console.error(`[MCP] 关闭「${id}」`, e);
        }
      }
      mcpLog("close:done", {});
    },
  };
}

export function createDisabledMcpPool(): McpPool {
  return {
    configured: false,
    getStatus: () => [],
    listTools: async () => [],
    callTool: async () => {
      throw new Error("MCP 未配置或已禁用");
    },
    close: async () => {},
  };
}
