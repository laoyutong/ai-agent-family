import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { createApiApp } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** apps/chatbot-memory 根目录 */
const root = path.join(__dirname, "..", "..");

/** 启动前校验 `DEEPSEEK_API_KEY`，缺失则打印说明并退出进程 */
function requireApiKey(): void {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error(
      "缺少 DEEPSEEK_API_KEY：请在仓库根目录配置 .env（参考 .env.example）",
    );
    process.exit(1);
  }
}

/** 开发模式入口：Vite 中间件 + API 同端口 */
async function main(): Promise<void> {
  requireApiKey();

  const { app, shutdown } = await createApiApp();
  const vite = await createViteServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "spa",
  });

  app.use(vite.middlewares);

  const PORT = Number(process.env.PORT) || 5173;
  const server = app.listen(PORT, () => {
    console.log(`开发服务器（前端 + API）http://127.0.0.1:${PORT}`);
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
