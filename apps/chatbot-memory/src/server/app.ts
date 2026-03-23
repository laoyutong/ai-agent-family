import express from "express";
import { createMemoryChatbot } from "./chatbot.js";
import { createDisabledMcpPool, createMcpPool, type McpPool } from "./mcp.js";

export type ApiAppResult = {
  app: express.Application;
  /** 释放 MCP 子进程与 HTTP 会话 */
  shutdown: () => Promise<void>;
};

/** 组装 Express 应用：挂载 JSON、`/api/chat` 流式对话、`/api/clear` 清会话、MCP 状态与工具调用 */
export async function createApiApp(): Promise<ApiAppResult> {
  let mcp: McpPool;
  try {
    mcp = await createMcpPool();
    if (mcp.configured) {
      console.log(
        "[MCP][HTTP] 路由已挂载: GET /api/mcp/status | GET /api/mcp/tools | POST /api/mcp/call",
      );
    }
  } catch (e) {
    console.error("[MCP] 初始化失败，MCP API 将不可用:", e);
    mcp = createDisabledMcpPool();
  }

  const bot = createMemoryChatbot({ mcp });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  /** 从请求头读取会话 id，缺省为 `anonymous` */
  function getSessionId(req: express.Request): string {
    const h = req.headers["x-session-id"];
    if (typeof h === "string" && h.trim()) return h.trim();
    return "anonymous";
  }

  app.get("/api/mcp/status", (_req, res) => {
    console.log("[MCP][HTTP] GET /api/mcp/status");
    res.json({
      configured: mcp.configured,
      servers: mcp.getStatus(),
    });
  });

  app.get("/api/mcp/tools", async (_req, res) => {
    console.log("[MCP][HTTP] GET /api/mcp/tools");
    try {
      const tools = await mcp.listTools();
      res.json({ tools });
    } catch (e) {
      console.error("[MCP][HTTP] GET /api/mcp/tools 失败", e);
      res.status(500).json({
        error: e instanceof Error ? e.message : "列出 MCP 工具失败",
      });
    }
  });

  app.post("/api/mcp/call", async (req, res) => {
    const serverId = typeof req.body?.serverId === "string" ? req.body.serverId.trim() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const args =
      req.body?.arguments !== undefined && req.body?.arguments !== null && typeof req.body.arguments === "object"
        ? (req.body.arguments as Record<string, unknown>)
        : undefined;
    console.log("[MCP][HTTP] POST /api/mcp/call", { serverId, name, hasArgs: args !== undefined });
    if (!serverId || !name) {
      res.status(400).json({ error: "需要非空 serverId 与 name" });
      return;
    }
    try {
      const result = await mcp.callTool(serverId, name, args);
      res.json({ result });
    } catch (e) {
      console.error("[MCP][HTTP] POST /api/mcp/call 失败", e);
      res.status(500).json({
        error: e instanceof Error ? e.message : "调用 MCP 工具失败",
      });
    }
  });

  app.post("/api/chat", async (req, res) => {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ error: "message 不能为空" });
      return;
    }
    const sessionId = getSessionId(req);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    /** 写入一条 SSE `data:` 行（JSON 序列化） */
    const sendSse = (obj: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    try {
      const stream = bot.stream(message, sessionId);
      for await (const text of stream) {
        if (text) sendSse({ text });
      }
      sendSse({ done: true });
      res.end();
    } catch (err) {
      console.error(err);
      sendSse({
        error: err instanceof Error ? err.message : "服务器错误",
      });
      res.end();
    }
  });

  app.post("/api/clear", (req, res) => {
    const sessionId = getSessionId(req);
    bot.clearSession(sessionId);
    res.json({ ok: true });
  });

  return {
    app,
    shutdown: () => mcp.close(),
  };
}
