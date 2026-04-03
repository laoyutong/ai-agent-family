import { glob } from "glob";
import path from "node:path";

export async function runGlobFiles(options: {
  pattern: string;
  cwd?: string;
  workspaceRoot: string;
}): Promise<string> {
  const cwd = path.resolve(options.cwd ?? options.workspaceRoot);
  const rel = path.relative(path.resolve(options.workspaceRoot), cwd);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return "错误：glob 的 cwd 必须在工作区内";
  }
  const files = await glob(options.pattern, {
    cwd,
    nodir: true,
    ignore: ["**/node_modules/**", "**/.git/**"],
  });
  const sorted = files.sort();
  if (sorted.length === 0) return "(无匹配文件)";
  const max = 200;
  const head = sorted.slice(0, max);
  const extra =
    sorted.length > max ? `\n… 共 ${sorted.length} 个，仅显示前 ${max} 个` : "";
  return head.join("\n") + extra;
}
