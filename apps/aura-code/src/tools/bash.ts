import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export async function runBash(options: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const { command, cwd, timeoutMs = 120_000, signal } = options;

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (e) {
      reject(e);
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });

    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const parts: string[] = [];
      if (stdout) parts.push(stdout.trimEnd());
      if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
      if (code !== 0 && code !== null) {
        parts.push(`[退出码 ${code}]`);
      }
      resolve(parts.join("\n") || "(无输出)");
    });
  });
}
