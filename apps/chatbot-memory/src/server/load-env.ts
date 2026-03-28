import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let loaded = false;

/**
 * 自本文件所在目录向上查找首个存在的 `.env` 并加载；找不到则退化为 `dotenv` 默认行为。
 * 放在 `server/` 根目录，并由 `index.ts` / `dev.ts` 最先 `import`，保证任意后续模块读到仓库根配置。
 */
export function loadEnvFromRepoRoot(): void {
  if (loaded) return;
  let dir = __dirname;
  for (;;) {
    const envPath = path.join(dir, ".env");
    if (existsSync(envPath)) {
      dotenv.config({ path: envPath });
      loaded = true;
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dotenv.config();
  loaded = true;
}

loadEnvFromRepoRoot();
