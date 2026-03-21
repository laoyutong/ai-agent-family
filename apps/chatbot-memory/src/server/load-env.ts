import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 从当前文件向上查找仓库根目录的 `.env` 并加载 */
let loaded = false;
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
