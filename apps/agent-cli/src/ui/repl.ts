import chalk from "chalk";
import readline from "node:readline";
import { fetchStreaming } from "../services/llm/client.js";
import type { ChatMessage } from "../services/llm/types.js";

const DEFAULT_SYSTEM =
  "You are a concise, helpful coding assistant running in the terminal.";

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err
    ? (err as { name: string }).name === "AbortError"
    : false;
}

export type ReplOptions = {
  chatUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
};

export async function runRepl(options: ReplOptions): Promise<void> {
  const {
    chatUrl,
    apiKey,
    model,
    systemPrompt = DEFAULT_SYSTEM,
  } = options;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let abortCurrent: AbortController | null = null;

  const onSigInt = (): void => {
    if (abortCurrent) {
      abortCurrent.abort();
      abortCurrent = null;
      process.stdout.write("^C\n");
    } else {
      process.stdout.write("\n");
      rl.close();
    }
  };

  rl.on("SIGINT", onSigInt);

  const prompt = (): void => {
    rl.setPrompt(chalk.cyan("> "));
    rl.prompt();
  };

  prompt();

  await new Promise<void>((resolve, reject) => {
    rl.on("line", async (line) => {
      const input = line.trim();
      if (!input) {
        prompt();
        return;
      }
      if (input === "exit" || input === "quit") {
        rl.close();
        return;
      }

      messages.push({ role: "user", content: input });
      abortCurrent = new AbortController();
      process.stdout.write(chalk.green("assistant: "));

      let assistant = "";
      try {
        for await (const chunk of fetchStreaming({
          chatUrl,
          apiKey,
          model,
          messages,
          signal: abortCurrent.signal,
        })) {
          if (chunk.type === "text") {
            process.stdout.write(chunk.text);
            assistant += chunk.text;
          } else if (chunk.type === "error") {
            process.stdout.write("\n");
            process.stdout.write(chalk.red(chunk.message) + "\n");
            messages.pop();
            abortCurrent = null;
            prompt();
            return;
          }
        }
        process.stdout.write("\n");
        messages.push({ role: "assistant", content: assistant || null });
      } catch (err) {
        process.stdout.write("\n");
        if (isAbortError(err)) {
          process.stdout.write(chalk.dim("(已中断)\n"));
          if (assistant.length > 0) {
            messages.push({ role: "assistant", content: assistant });
          }
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          process.stdout.write(chalk.red(msg) + "\n");
          messages.pop();
        }
      } finally {
        abortCurrent = null;
      }

      prompt();
    });

    rl.on("close", () => resolve());
    rl.on("error", (e) => reject(e));
  });
}

export async function runSingleShotStream(
  options: ReplOptions & { prompt: string },
): Promise<void> {
  const {
    chatUrl,
    apiKey,
    model,
    systemPrompt = DEFAULT_SYSTEM,
    prompt: userPrompt,
  } = options;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const ac = new AbortController();
  const onInt = (): void => {
    ac.abort();
  };
  process.once("SIGINT", onInt);

  try {
    for await (const chunk of fetchStreaming({
      chatUrl,
      apiKey,
      model,
      messages,
      signal: ac.signal,
    })) {
      if (chunk.type === "text") {
        process.stdout.write(chunk.text);
      } else if (chunk.type === "error") {
        process.stdout.write("\n" + chalk.red(chunk.message) + "\n");
        return;
      }
    }
    process.stdout.write("\n");
  } catch (err) {
    process.stdout.write("\n");
    if (isAbortError(err)) {
      process.stdout.write(chalk.dim("(已中断)\n"));
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(chalk.red(msg) + "\n");
    }
  } finally {
    process.off("SIGINT", onInt);
  }
}
