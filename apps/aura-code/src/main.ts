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
    await runSingleShotStream({ ...llm, prompt: text });
    return;
  }

  await runRepl(llm);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
