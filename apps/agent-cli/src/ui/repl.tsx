import { render } from "ink";
import { ChatApp } from "./chat-app.js";
import type { ReplOptions } from "./session-options.js";

export type { ReplOptions } from "./session-options.js";

export async function runRepl(options: ReplOptions): Promise<void> {
  const { waitUntilExit } = render(
    <ChatApp mode="repl" options={options} />,
    {
      exitOnCtrlC: false,
      patchConsole: true,
      maxFps: 30,
      // incremental 模式在部分终端下会残留旧行或看起来像「重复输出」
      incrementalRendering: false,
    },
  );
  await waitUntilExit();
}

export async function runSingleShotStream(
  options: ReplOptions & { prompt: string },
): Promise<void> {
  const { waitUntilExit } = render(
    <ChatApp mode="single" options={options} singlePrompt={options.prompt} />,
    {
      exitOnCtrlC: false,
      patchConsole: true,
      maxFps: 30,
      incrementalRendering: false,
    },
  );
  await waitUntilExit();
}
