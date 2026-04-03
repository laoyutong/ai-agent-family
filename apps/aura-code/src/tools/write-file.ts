import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveInWorkspace } from "./paths.js";

export function runWriteFile(options: {
  path: string;
  content: string;
  cwd: string;
}): string {
  const abs = resolveInWorkspace(options.path, options.cwd);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, options.content, "utf8");
  return `已写入 ${options.path}（${options.content.length} 字符）`;
}
