import type { ToolCall } from "../services/llm/types.js";

export type AgentStepTone = "round" | "invoke" | "done" | "fail" | "note";

export type AgentStep = {
  tone: AgentStepTone;
  title: string;
  /** OpenAI tool_calls[].id，用于合并同一工具的状态更新、避免重复条目 */
  toolCallId?: string;
  /** 调用说明（父级下的子行） */
  detail?: string;
  /** 工具已正常结束（无 outcome 文案时也需写入日志） */
  invokeComplete?: boolean;
  /** 仅失败等异常：简短结果说明 */
  outcome?: string;
};

/** 传给 UI：一行 Spinner 文案 + 可选步骤条目 */
export type RunStatusUpdate = {
  spinnerHint: string;
  step?: AgentStep;
};

const TOOL_LABEL: Record<string, string> = {
  run_command: "Shell",
  read_file: "读文件",
  write_file: "写入",
  search_replace: "替换",
  glob_files: "Glob",
  grep_content: "Grep",
};

function clipOneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1))}…`;
}

function parseArgs(tc: ToolCall): Record<string, unknown> {
  try {
    return JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function argStr(args: Record<string, unknown>, k: string): string {
  return typeof args[k] === "string" ? args[k] : String(args[k] ?? "");
}

function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name;
}

/** 「执行xxx工具 / xxx工具的执行结果」中的 xxx（简短名） */
const TOOL_EXECUTE_NOUN: Record<string, string> = {
  run_command: "Shell",
  read_file: "读文件",
  write_file: "写入文件",
  search_replace: "文本替换",
  glob_files: "文件查找",
  grep_content: "内容搜索",
};

function toolExecuteNoun(name: string): string {
  return TOOL_EXECUTE_NOUN[name] ?? toolLabel(name);
}

/** 工具完成态：统一带「执行结果：」前缀，便于辨认 */
function withOutcomeLabel(body: string, bodyMax: number): string {
  const clipped = clipOneLine(body.replace(/\n/g, " "), bodyMax);
  return `执行结果：${clipped}`;
}

/** 一行内说明「对谁 / 做了什么」，与结果摘要拼接 */
function shortToolContext(tc: ToolCall): string {
  const name = tc.function.name;
  const args = parseArgs(tc);
  switch (name) {
    case "run_command":
      return clipOneLine(argStr(args, "command"), 48);
    case "read_file": {
      const path = argStr(args, "path");
      const off = args.offset;
      const lim = args.limit;
      let extra = "";
      if (typeof off === "number" && typeof lim === "number") {
        extra = ` L${off}-${off + lim - 1}`;
      } else if (typeof off === "number") {
        extra = ` L${off}+`;
      } else if (typeof lim === "number") {
        extra = ` ≤${lim}行`;
      }
      return clipOneLine(path + extra, 56);
    }
    case "write_file":
    case "search_replace":
      return clipOneLine(argStr(args, "path"), 44);
    case "glob_files": {
      const pat = clipOneLine(argStr(args, "pattern"), 36);
      const cwd = args.cwd ? argStr(args, "cwd") : "";
      return cwd ? `${pat} @${clipOneLine(cwd, 20)}` : pat;
    }
    case "grep_content": {
      const pat = clipOneLine(argStr(args, "pattern"), 28);
      const p = args.path ? argStr(args, "path") : "";
      return p ? `${pat} @${clipOneLine(p, 20)}` : pat;
    }
    default:
      return clipOneLine(tc.function.arguments || "", 40);
  }
}

/**
 * 单行：执行（含 API 名）+ 具体操作对象，无「说明」等前缀。
 */
export function formatToolRunning(tc: ToolCall): AgentStep {
  const name = tc.function.name;
  const noun = toolExecuteNoun(name);
  const args = parseArgs(tc);
  const head = `执行${noun}工具（${name}）`;

  if (name === "run_command") {
    const cmd = clipOneLine(argStr(args, "command"), 48);
    const title = cmd ? `${head} · ${cmd}` : head;
    return { tone: "invoke", title, toolCallId: tc.id };
  }

  const ctx = shortToolContext(tc);
  const title = ctx ? `${head} · ${ctx}` : head;
  return { tone: "invoke", title, toolCallId: tc.id };
}

/** 工具失败：一行「执行结果：…」（成功态不再展示结果摘要） */
export function formatToolOutcomeSummary(_tc: ToolCall, text: string): string {
  return withOutcomeLabel(text.trim(), 56);
}

