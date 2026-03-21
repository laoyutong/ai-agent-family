import express from "express";
import { createMemoryChatbot } from "./chatbot.js";

export function createApiApp(): express.Application {
  const bot = createMemoryChatbot();
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  function getSessionId(req: express.Request): string {
    const h = req.headers["x-session-id"];
    if (typeof h === "string" && h.trim()) return h.trim();
    return "anonymous";
  }

  /** 从 LangChain 流式 chunk 取出文本增量 */
  function chunkToText(chunk: unknown): string {
    if (!chunk || typeof chunk !== "object") return "";
    if (!("content" in chunk)) return "";
    const c = (chunk as { content: unknown }).content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((x) =>
          x && typeof x === "object" && "text" in x ? String((x as { text: string }).text) : "",
        )
        .join("");
    }
    return "";
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

    const sendSse = (obj: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    try {
      const stream = await bot.stream(message, sessionId);
      for await (const chunk of stream) {
        const text = chunkToText(chunk);
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
