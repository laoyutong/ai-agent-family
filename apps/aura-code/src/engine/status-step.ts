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

export function formatToolInvoke(tc: ToolCall): AgentStep {
  const name = tc.function.name;
  const label = toolLabel(name);
  const args = parseArgs(tc);

  let detail: string | undefined;
  switch (name) {
    case "run_command": {
      detail = clipOneLine(argStr(args, "command"), 96);
      break;
    }
    case "read_file": {
      const path = argStr(args, "path");
      const off = args.offset;
      const lim = args.limit;
      let extra = "";
      if (typeof off === "number" && typeof lim === "number") {
        extra = ` · 行 ${off}–${off + lim - 1}`;
      } else if (typeof off === "number") {
        extra = ` · 从行 ${off}`;
      } else if (typeof lim === "number") {
        extra = ` · 最多 ${lim} 行`;
      }
      detail = clipOneLine(path + extra, 88);
      break;
    }
    case "write_file": {
      detail = clipOneLine(argStr(args, "path"), 72);
      break;
    }
    case "search_replace": {
      detail = clipOneLine(argStr(args, "path"), 72);
      break;
    }
    case "glob_files": {
      const pat = clipOneLine(argStr(args, "pattern"), 48);
      const cwd = args.cwd ? argStr(args, "cwd") : "";
      detail = cwd ? `${pat} · ${clipOneLine(cwd, 32)}` : pat;
      break;
    }
    case "grep_content": {
      const pat = clipOneLine(argStr(args, "pattern"), 40);
      const p = args.path ? argStr(args, "path") : "";
      const g = args.glob ? argStr(args, "glob") : "";
      const bits = [pat];
      if (p) bits.push(`@${clipOneLine(p, 28)}`);
      if (g) bits.push(`(${clipOneLine(g, 20)})`);
      detail = bits.join(" ");
      break;
    }
    default:
      detail = clipOneLine(tc.function.arguments || "", 64);
  }

  return {
    tone: "invoke",
    title: label,
    detail: detail || undefined,
  };
}

/** 根据工具输出缩为适合终端展示的摘要（正文仍完整发往模型） */
export function formatToolResult(name: string, text: string): AgentStep {
  const label = toolLabel(name);
  const err = text.startsWith("错误：");
  const raw = text.trim();
  let detail = "";

  if (name === "read_file" && !err) {
    const lines = raw.split("\n");
    const n = lines.length;
    if (n <= 3) {
      detail = lines.map((ln) => clipOneLine(ln, 100)).join(" · ");
    } else {
      const head = clipOneLine(lines[0] ?? "", 88);
      detail = `${head} · … 共 ${n} 行`;
    }
  } else if (name === "glob_files" && !err) {
    const ls = raw.split("\n").filter(Boolean);
    const n = ls.length;
    detail =
      n === 0
        ? "无匹配"
        : n <= 2
          ? ls.join(" · ")
          : `${clipOneLine(ls[0] ?? "", 48)} 等 ${n} 条`;
  } else if (name === "grep_content" && !err) {
    const ls = raw.split("\n").filter(Boolean);
    const n = ls.length;
    detail =
      n === 0
        ? "无匹配"
        : n === 1
          ? clipOneLine(ls[0] ?? "", 100)
          : `${clipOneLine(ls[0] ?? "", 72)} · … ${n} 处`;
  } else {
    detail = clipOneLine(raw.replace(/\n/g, " ↵ "), 120);
  }

  return {
    tone: err ? "fail" : "done",
    title: label,
    detail: detail || undefined,
  };
}
