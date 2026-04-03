import { spawn } from "node:child_process";
import path from "node:path";

export async function runGrepContent(options: {
  pattern: string;
  searchPath?: string;
  glob?: string;
  cwd: string;
}): Promise<string> {
  const cwd = path.resolve(options.cwd);
  const target = options.searchPath
    ? path.resolve(cwd, options.searchPath)
    : cwd;

  const args = [
    options.pattern,
    target,
    "-n",
    "--color",
    "never",
    "--heading",
    "--smart-case",
  ];
  if (options.glob) {
    args.push("--glob", options.glob);
  }
  args.push("--glob", "!**/node_modules/**", "--glob", "!.git/**");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (s: string): void => {
      if (settled) return;
      settled = true;
      resolve(s);
    };

    const child = spawn("rg", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", () => {
      finish(
        "未找到 ripgrep (rg)。请安装: https://github.com/BurntSushi/ripgrep ，或改用 glob_files + read_file。",
      );
    });
    child.on("close", (code) => {
      if (code === 1) {
        finish("(无匹配)");
        return;
      }
      if (code !== 0 && stderr) {
        finish(`rg 错误: ${stderr.trim()}`);
        return;
      }
      const lines = stdout.trim().split("\n").filter(Boolean);
      const max = 300;
      const head = lines.slice(0, max);
      const extra =
        lines.length > max ? `\n… 共 ${lines.length} 行，仅显示前 ${max} 行` : "";
      finish(head.join("\n") + extra || "(无匹配)");
    });
  });
}
