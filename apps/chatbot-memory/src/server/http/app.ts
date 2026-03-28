import express from "express";
import { createMemoryChatbot } from "../chat/chatbot.js";
import { parseIntEnv } from "../config/chat-env.js";
import { createDisabledMcpPool, createMcpPool, type McpPool } from "../mcp/mcp.js";
import {
  FoldArchiveStore,
  parseFoldArchiveEnabled,
  resolveFoldArchiveBaseDir,
} from "../persistence/fold-archive-store.js";
import { createSessionStore, type SessionStore } from "../persistence/session-store.js";
import { createUserFactsStore, UserFactsStore } from "../persistence/user-facts-store.js";

export type ApiAppResult = {
  app: express.Application;
  /** 刷盘会话、释放 MCP 子进程与 HTTP 会话 */
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

  const sessionStore: SessionStore = await createSessionStore();
  const userFactsMaxLines = parseIntEnv("CHAT_USER_FACTS_MAX_LINES", 200);
  const userFactsStore = await createUserFactsStore(
    UserFactsStore.defaultPath(),
    userFactsMaxLines,
  );

  const foldArchiveEnabled = parseFoldArchiveEnabled();
  const foldArchiveStore = foldArchiveEnabled
    ? new FoldArchiveStore(resolveFoldArchiveBaseDir(sessionStore))
    : null;
  sessionStore.bindFoldArchive(foldArchiveStore);

  const bot = createMemoryChatbot({
    mcp,
    sessionStore,
    userFactsStore,
    foldArchiveInjectStore: foldArchiveStore ?? undefined,
    onFoldDroppedArchive: foldArchiveStore
      ? async ({ sessionId, mode, dropped }) => {
          const mem = sessionStore.getMemory(sessionId);
          return foldArchiveStore.append(sessionId, mode, dropped, {
            summaryBefore: mem?.summary,
            factsBefore: mem?.facts,
          });
        }
      : undefined,
    onFoldArchiveFinalized: foldArchiveStore
      ? async ({ sessionId, mode, ref, session }) => {
          await foldArchiveStore.finalizeEntry(sessionId, ref.index, {
            summaryAfter: session.summary,
            factsAfter: session.facts,
          });
          session.foldArchiveLinks = session.foldArchiveLinks ?? [];
          session.foldArchiveLinks.push({
            index: ref.index,
            mode,
            createdAt: ref.createdAt,
          });
        }
      : undefined,
  });

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
    console.log("[Chat][HTTP] POST /api/chat", { sessionId, userChars: message.length });

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
      for await (const part of stream) {
        if (part.type === "phase") {
          sendSse({ phase: part.phase });
        } else if (part.type === "text" && part.text) {
          sendSse({ text: part.text });
        }
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

  app.get("/api/user-facts", (_req, res) => {
    res.json({ facts: userFactsStore.getFacts() });
  });

  app.patch("/api/user-facts", (req, res) => {
    const facts = typeof req.body?.facts === "string" ? req.body.facts : undefined;
    if (facts === undefined) {
      res.status(400).json({ error: "需要字符串字段 facts" });
      return;
    }
    userFactsStore.setFacts(facts);
    res.json({ ok: true, facts: userFactsStore.getFacts() });
  });

  app.delete("/api/user-facts", (_req, res) => {
    userFactsStore.clear();
    res.json({ ok: true });
  });

  app.get("/api/sessions", (_req, res) => {
    res.json({ sessions: sessionStore.listSessions() });
  });

  app.post("/api/sessions", (_req, res) => {
    const id = sessionStore.createSession();
    res.status(201).json({ id });
  });

  app.get("/api/sessions/:sessionId/fold-archives", async (req, res) => {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId.trim() : "";
    if (!sessionId) {
      res.status(400).json({ error: "缺少 sessionId" });
      return;
    }
    if (!sessionStore.has(sessionId)) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }
    if (!foldArchiveStore) {
      res.json({ enabled: false, entries: [] });
      return;
    }
    const entries = await foldArchiveStore.list(sessionId);
    res.json({ enabled: true, entries });
  });

  app.get("/api/sessions/:sessionId/fold-archives/:index", async (req, res) => {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId.trim() : "";
    const idxRaw = typeof req.params.index === "string" ? req.params.index.trim() : "";
    const index = Number.parseInt(idxRaw, 10);
    if (!sessionId) {
      res.status(400).json({ error: "缺少 sessionId" });
      return;
    }
    if (!sessionStore.has(sessionId)) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }
    if (!foldArchiveStore) {
      res.status(404).json({ error: "归档未启用" });
      return;
    }
    const rec = await foldArchiveStore.get(sessionId, index);
    if (!rec) {
      res.status(404).json({ error: "归档不存在" });
      return;
    }
    res.json(rec);
  });

  app.get("/api/sessions/:sessionId", (req, res) => {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId.trim() : "";
    if (!sessionId) {
      res.status(400).json({ error: "缺少 sessionId" });
      return;
    }
    const payload = sessionStore.getSessionPayload(sessionId);
    if (!payload) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }
    res.json(payload);
  });

  app.patch("/api/sessions/:sessionId", (req, res) => {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId.trim() : "";
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!sessionId) {
      res.status(400).json({ error: "缺少 sessionId" });
      return;
    }
    if (!sessionStore.has(sessionId)) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }
    if (!title) {
      res.status(400).json({ error: "title 不能为空" });
      return;
    }
    sessionStore.setTitle(sessionId, title);
    res.json({ ok: true });
  });

  app.delete("/api/sessions/:sessionId", (req, res) => {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId.trim() : "";
    if (!sessionId) {
      res.status(400).json({ error: "缺少 sessionId" });
      return;
    }
    const ok = sessionStore.deleteSession(sessionId);
    if (!ok) {
      res.status(404).json({ error: "会话不存在" });
      return;
    }
    res.json({ ok: true });
  });

  return {
    app,
    shutdown: async () => {
      await sessionStore.flushPending();
      await userFactsStore.flushPending();
      await mcp.close();
    },
  };
}
