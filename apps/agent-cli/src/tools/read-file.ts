import { readFileSync, statSync } from "node:fs";
import { resolveInWorkspace } from "./paths.js";

export function runReadFile(options: {
  path: string;
  offset?: number;
  limit?: number;
  cwd: string;
}): string {
  const abs = resolveInWorkspace(options.path, options.cwd);
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st) return `错误：文件不存在 ${options.path}`;
  if (st.isDirectory()) return `错误：是目录而非文件 ${options.path}`;

  const buf = readFileSync(abs);
  if (buf.includes(0)) {
    return `[二进制文件，已跳过] ${options.path} (${buf.length} bytes)`;
  }

  let text = buf.toString("utf8");
  const lines = text.split("\n");
  const hasRange = options.offset != null || options.limit != null;
  const off = Math.max(1, options.offset ?? 1);
  const lim = options.limit ?? (hasRange ? lines.length - (off - 1) : lines.length);
  if (hasRange) {
    const start = off - 1;
    const slice = lines.slice(start, start + lim);
    const numbered = slice.map(
      (ln, i) => `${String(off + i).padStart(5, " ")}|${ln}`,
    );
    return numbered.join("\n");
  }
  return text;
}
