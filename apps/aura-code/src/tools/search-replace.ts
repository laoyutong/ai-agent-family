import { readFileSync, writeFileSync } from "node:fs";
import { resolveInWorkspace } from "./paths.js";

export function runSearchReplace(options: {
  path: string;
  old_string: string;
  new_string: string;
  cwd: string;
}): string {
  const abs = resolveInWorkspace(options.path, options.cwd);
  const text = readFileSync(abs, "utf8");
  const { old_string, new_string } = options;
  const n = text.split(old_string).length - 1;
  if (n === 0) {
    return `错误：未找到 old_string（请检查内容与唯一性）: ${options.path}`;
  }
  if (n > 1) {
    return `错误：old_string 出现 ${n} 次，需唯一匹配才能替换: ${options.path}`;
  }
  const next = text.replace(old_string, new_string);
  writeFileSync(abs, next, "utf8");
  return `已替换 1 处: ${options.path}`;
}
