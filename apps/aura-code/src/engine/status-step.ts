import type { ToolCall } from "../services/llm/types.js";

export type AgentStepTone = "round" | "invoke" | "done" | "fail" | "note";

export type AgentStep = {
  tone: AgentStepTone;
  title: string;
  detail?: string;
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

function summarizeToolOutput(name: string, text: string): string {
  const err = text.startsWith("错误：");
  const raw = text.trim();

  if (name === "read_file" && !err) {
    const lines = raw.split("\n");
    const n = lines.length;
    if (n <= 1) {
      return clipOneLine(lines[0] ?? "(空)", 56);
    }
    return `… ${n} 行`;
  }
  if (name === "glob_files" && !err) {
    const ls = raw.split("\n").filter(Boolean);
    const n = ls.length;
    if (n === 0) return "无匹配";
    if (n === 1) return clipOneLine(ls[0] ?? "", 44);
    return `${n} 条`;
  }
  if (name === "grep_content" && !err) {
    const ls = raw.split("\n").filter(Boolean);
    const n = ls.length;
    if (n === 0) return "无匹配";
    if (n === 1) return clipOneLine(ls[0] ?? "", 56);
    return `${n} 处`;
  }
  if (name === "write_file" && !err) {
    return clipOneLine(raw.replace(/\n/g, " "), 48);
  }
  if (name === "search_replace" && !err) {
    return clipOneLine(raw.replace(/\n/g, " "), 48);
  }
  return clipOneLine(raw.replace(/\n/g, "↵"), 64);
}

/** 单条工具：调用参数 + 结果一条写完（替代原先的 invoke + result 两步） */
export function formatToolOutcome(tc: ToolCall, text: string): AgentStep {
  const name = tc.function.name;
  const label = toolLabel(name);
  const err = text.startsWith("错误：");
  const ctx = shortToolContext(tc);
  const sum = summarizeToolOutput(name, text);
  const detail = ctx ? `${ctx} → ${sum}` : sum;
  return {
    tone: err ? "fail" : "done",
    title: label,
    detail: detail || undefined,
  };
}
