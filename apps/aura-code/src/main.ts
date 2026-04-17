#!/usr/bin/env node
import "./load-env.js";
import chalk from "chalk";
import { buildAppConfig, requireApiKey } from "./config.js";
import { parseCli } from "./cli.js";
import { chatCompletionsUrl } from "./services/llm/index.js";
import { runRepl, runSingleShotStream } from "./ui/repl.js";

async function main(): Promise<void> {
  const cli = parseCli(process.argv);
  const config = buildAppConfig(cli);
  requireApiKey(config);

  process.chdir(config.cwd);

  // 禁用终端鼠标事件报告，避免点击导致渲染异常
  // 1000: 发送鼠标点击事件 (X10)
  // 1002: 发送鼠标拖动事件
  // 1006: 使用 SGR 扩展格式
  let mouseDisableTimer: ReturnType<typeof setInterval> | null = null;
  if (process.stdout.isTTY) {
    const disableMouse = () => {
      process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l');
    };
    disableMouse();
    // 某些终端会在 resize 或焦点变化后重新启用鼠标报告，定期确保禁用
    mouseDisableTimer = setInterval(disableMouse, 1000);
  }

  const chatUrl = chatCompletionsUrl(config.baseUrl);
  const llm = {
    chatUrl,
    apiKey: config.apiKey,
    model: config.model,
    cwd: config.cwd,
  };

  if (cli.prompt !== undefined) {
    const text = cli.prompt ?? "";
    if (!text.trim()) {
      console.error(chalk.red("单次模式需要非空 -p/--prompt"));
      process.exit(1);
    }
    try {
      await runSingleShotStream({ ...llm, prompt: text });
    } finally {
      // 清理定时器
      if (mouseDisableTimer) {
        clearInterval(mouseDisableTimer);
      }
      // 恢复终端状态
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[?25h'); // 显示光标
      }
    }
    return;
  }

  try {
    await runRepl(llm);
  } finally {
    // 清理定时器
    if (mouseDisableTimer) {
      clearInterval(mouseDisableTimer);
    }
    // 恢复终端状态
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[?25h'); // 显示光标
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
