import type { ChatMessage } from "../services/llm/types.js";
import type { AgentStep } from "./status-step.js";
import {
  formatToolOutcomeSummary,
  formatToolRunning,
} from "./status-step.js";

/** 与 chat-app 中 tighten 规则一致，避免气泡里空行过大 */
function tightenAssistantText(text: string): string {
  return text
    .replace(/(?:\r?\n[ \t]*){2,}/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

export type AssistantTurnBlock =
  | { kind: "text"; text: string }
  | { kind: "tools"; steps: AgentStep[] };

/**
 * 按对话真实顺序还原：每一段模型正文后接「该轮」工具步骤（可能多轮 read→tool→reply）。
 */
export function buildAssistantTurnBlocks(
  messages: ChatMessage[],
  userMessageIndex: number,
): AssistantTurnBlock[] {
  const blocks: AssistantTurnBlock[] = [];
  let i = userMessageIndex + 1;

  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role === "user") break;
    if (m.role !== "assistant") {
      i += 1;
      continue;
    }

    const c = m.content;
    if (typeof c === "string" && c.trim().length > 0) {
      blocks.push({ kind: "text", text: tightenAssistantText(c) });
    }

    const calls = m.tool_calls;
    if (calls?.length) {
      let j = i + 1;
      const outs = new Map<string, string>();
      while (j < messages.length && messages[j]!.role === "tool") {
        const t = messages[j]!;
        outs.set(t.tool_call_id ?? "", String(t.content ?? ""));
        j += 1;
      }

      const steps: AgentStep[] = [];
      for (const tc of calls) {
        const out = outs.get(tc.id) ?? "";
        const runningStep = formatToolRunning(tc);
        const failed = out.trimStart().startsWith("错误：");
        steps.push({
          tone: "invoke",
          title: runningStep.title,
          toolCallId: runningStep.toolCallId,
          ...(failed
            ? { outcome: formatToolOutcomeSummary(tc, out) }
            : { invokeComplete: true }),
        });
      }
      if (steps.length > 0) {
        blocks.push({ kind: "tools", steps });
      }
      i = j;
    } else {
      i += 1;
    }
  }

  return blocks;
}

/**
 * `run-with-tools` 在每轮模型请求前插入 `tone: round`，用于把扁平 stepLog 切成与流式分段一一对应的工具组。
 */
export function splitStepLogIntoToolGroups(log: AgentStep[]): AgentStep[][] {
  const groups: AgentStep[][] = [];
  let cur: AgentStep[] = [];
  for (const s of log) {
    if (s.tone === "round") {
      groups.push(cur);
      cur = [];
      continue;
    }
    if (s.tone === "fail" || s.tone === "invoke") {
      cur.push(s);
    }
  }
  groups.push(cur);
  return groups.filter((g) => g.length > 0);
}
