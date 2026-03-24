import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApiApp } from "./app.js";
import { requireDeepseekApiKey } from "./require-api-key.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  requireDeepseekApiKey();

  const { app, shutdown } = await createApiApp();
  const clientDir = path.join(__dirname, "..", "client");

  app.use(express.static(clientDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });

  const PORT = Number(process.env.PORT) || 3001;
  const server = app.listen(PORT, () => {
    console.log(`聊天服务已启动 http://127.0.0.1:${PORT}`);
  });

  const stop = async () => {
    try {
      await shutdown();
    } finally {
      server.close(() => process.exit(0));
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
