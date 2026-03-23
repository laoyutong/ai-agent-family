import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApiApp } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 启动前校验 `DEEPSEEK_API_KEY`，缺失则打印说明并退出进程 */
function requireApiKey(): void {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error(
      "缺少 DEEPSEEK_API_KEY：请在仓库根目录配置 .env（参考 .env.example）",
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  requireApiKey();

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
