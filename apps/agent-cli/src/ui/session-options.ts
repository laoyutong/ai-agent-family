export const DEFAULT_SYSTEM =
  "You are a concise, helpful coding assistant running in the terminal.";

/** 含工作区说明与工具使用提示，供「系统」角色使用 */
export function buildAgentSystem(
  override: string | undefined,
  cwd: string,
): string {
  const base = (override?.trim() || DEFAULT_SYSTEM).trim();
  return `${base}

## 工作区
- 当前目录: ${cwd}
- read_file / write_file / search_replace / glob_files：路径须在此目录内（可相对或绝对，但不得越界）。
- run_command：可执行任意 shell；cd 只对当前命令行有效，后续命令若依赖目录请先写在一行里（如 \`cd pkg && npm test\`）。
- grep_content：需本机已安装 ripgrep（\`rg\`）；否则请用 glob_files + read_file。
- 任务尽量先做小步工具调用，再给出简明中文结论。`;
}

export type ReplOptions = {
  chatUrl: string;
  apiKey: string;
  model: string;
  cwd?: string;
  systemPrompt?: string;
};

export function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err
    ? (err as { name: string }).name === "AbortError"
    : false;
}
