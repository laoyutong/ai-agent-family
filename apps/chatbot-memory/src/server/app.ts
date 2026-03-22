import express from "express";
import { createMemoryChatbot } from "./chatbot.js";

/** 组装 Express 应用：挂载 JSON、`/api/chat` 流式对话、`/api/clear` 清会话 */
export function createApiApp(): express.Application {
  const bot = createMemoryChatbot();
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  /** 从请求头读取会话 id，缺省为 `anonymous` */
  function getSessionId(req: express.Request): string {
    const h = req.headers["x-session-id"];
    if (typeof h === "string" && h.trim()) return h.trim();
    return "anonymous";
  }

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

  return app;
}
