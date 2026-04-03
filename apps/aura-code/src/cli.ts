import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import type { CliOptions } from "./types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  const pkgPath = path.join(__dirname, "..", "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
}

export function parseCli(argv: string[]): CliOptions {
  const program = new Command();
  program
    .name("aura-code")
    .description("光环代码：终端 AI 编程助手（DeepSeek API）")
    .version(readVersion(), "-V, --version")
    .option(
      "-m, --model <id>",
      "DeepSeek 模型 id",
      process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    )
    .option("--cwd <path>", "工作目录", process.cwd())
    .option(
      "-p, --prompt <text>",
      "单次模式：执行该提示后退出（LLM 将在后续阶段接入）",
    );

  program.parse(argv);
  const opts = program.opts() as {
    model: string;
    cwd: string;
    prompt?: string;
  };

  return {
    model: opts.model,
    cwd: opts.cwd,
    prompt: opts.prompt,
  };
}
