import type { OpenAITool, ToolCall } from "../services/llm/types.js";
import type { ToolPermissionLevel } from "../types/index.js";
import { runBash } from "./bash.js";
import { runGlobFiles } from "./glob-files.js";
import { runGrepContent } from "./grep-content.js";
import { runReadFile } from "./read-file.js";
import { runSearchReplace } from "./search-replace.js";
import { runWriteFile } from "./write-file.js";

export const MAX_TOOL_ROUNDS = 64;

/** 工具权限级别定义 */
export const TOOL_PERMISSIONS: Record<string, ToolPermissionLevel> = {
  read_file: "safe",
  glob_files: "safe",
  grep_content: "safe",
  write_file: "dangerous",
  search_replace: "dangerous",
  run_command: "dangerous",
};

/** 获取工具的权限级别 */
export function getToolPermissionLevel(toolName: string): ToolPermissionLevel {
  return TOOL_PERMISSIONS[toolName] ?? "dangerous";
}

/** 判断工具是否需要用户确认 */
export function toolRequiresConfirmation(toolName: string): boolean {
  return getToolPermissionLevel(toolName) === "dangerous";
}

export function getDefaultTools(): OpenAITool[] {
  return [
    {
      type: "function",
      function: {
        name: "run_command",
        description:
          "在用户工作区内执行 shell 命令（bash）。可组合 cd、git、npm 等。长任务可调大 timeout_ms。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "完整 shell 命令" },
            timeout_ms: {
              type: "integer",
              description: "超时毫秒数，默认 120000",
            },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "读取工作区内文本文件。可用 offset+limit 按行截取（从 1 计行号）。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "相对工作区或绝对路径（须在工作区内）" },
            offset: { type: "integer", description: "起始行号（可选）" },
            limit: { type: "integer", description: "最多行数（可选）" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "写入或覆盖工作区内文件，自动创建父目录。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string", description: "完整文件内容" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_replace",
        description:
          "在文件中用 new_string 唯一替换一处 old_string（old_string 必须在文件中恰好出现一次）。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "glob_files",
        description: "按 glob 模式列出匹配文件路径（相对 cwd），不含目录。",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "glob，如 **/*.ts" },
            cwd: {
              type: "string",
              description: "搜索起点，默认工作区根；须在工作区内",
            },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep_content",
        description:
          "用 ripgrep 在代码中搜索正则 pattern。需要系统已安装 rg。",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "ripgrep 正则" },
            path: {
              type: "string",
              description: "相对工作区的文件或目录，默目录为工作区根",
            },
            glob: {
              type: "string",
              description: "文件过滤 glob，如 *.ts",
            },
          },
          required: ["pattern"],
        },
      },
    },
  ];
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export async function executeToolCall(
  tc: ToolCall,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const name = tc.function.name;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return "错误：工具参数不是合法 JSON";
  }

  const str = (k: string): string =>
    typeof args[k] === "string" ? args[k] : String(args[k] ?? "");

  try {
    switch (name) {
      case "run_command": {
        const command = str("command");
        if (!command.trim()) return "错误：command 为空";
        return await runBash({
          command,
          cwd: workspaceRoot,
          timeoutMs: num(args.timeout_ms),
          signal,
        });
      }
      case "read_file":
        return runReadFile({
          path: str("path"),
          offset: num(args.offset),
          limit: num(args.limit),
          cwd: workspaceRoot,
        });
      case "write_file":
        return runWriteFile({
          path: str("path"),
          content: typeof args.content === "string" ? args.content : "",
          cwd: workspaceRoot,
        });
      case "search_replace":
        return runSearchReplace({
          path: str("path"),
          old_string: typeof args.old_string === "string" ? args.old_string : "",
          new_string: typeof args.new_string === "string" ? args.new_string : "",
          cwd: workspaceRoot,
        });
      case "glob_files":
        return await runGlobFiles({
          pattern: str("pattern"),
          cwd: args.cwd ? str("cwd") : undefined,
          workspaceRoot,
        });
      case "grep_content":
        return await runGrepContent({
          pattern: str("pattern"),
          searchPath: args.path ? str("path") : undefined,
          glob: args.glob ? str("glob") : undefined,
          cwd: workspaceRoot,
        });
      default:
        return `错误：未知工具 ${name}`;
    }
  } catch (e) {
    return `错误：${e instanceof Error ? e.message : String(e)}`;
  }
}
