import { clipText } from "../shared/text.js";
import type { McpPool } from "./mcp.js";
import type { ChatMcpPayloadLimits } from "./chat-mcp-limits.js";

export type McpPlanStep = {
  id: string;
  goal: string;
  notes?: string;
};

export type McpPlan = {
  steps: McpPlanStep[];
};

const MCP_PLANNER_SYSTEM = `你是任务规划助手。根据用户问题与可用 MCP 工具列表，将完成任务的过程拆成**有序步骤**（2～8 步；若明显一步即可，可只输出 1 步）。
每一步应具体到「本步要搞清楚什么 / 调用什么能力」，便于下一步写代码调用 mcp。

【输出格式】请只输出**恰好一个** fenced 代码块，语言标记为 \`json\`。块内为 JSON 对象，不要有注释或尾随逗号。格式示例：
\`\`\`json
{
  "steps": [
    { "id": "1", "goal": "列出某目录下的文件以确认路径", "notes": "可选，给工具参数的路径提示" },
    { "id": "2", "goal": "读取目标文件内容并提取要点", "notes": "" }
  ]
}
\`\`\`

要求：
- 每一步必须有非空的 "id" 与 "goal"（字符串）。
- "notes" 可选。
- 不要输出 json 代码块以外的任何文字。`;

function buildPlannerToolsHint(
  listed: Awaited<ReturnType<McpPool["listTools"]>>,
  limits: ChatMcpPayloadLimits,
): string {
  const slice = listed.slice(0, limits.maxTools);
  const lines: string[] = [];
  let bytes = 0;
  const maxBytes = 16_000;
  for (const t of slice) {
    const desc = clipText((t.description ?? "").trim(), 240);
    const line = `- ${t.serverId}/${t.name}${desc ? `: ${desc}` : ""}`;
    const b = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + b > maxBytes) break;
    bytes += b;
    lines.push(line);
  }
  return lines.join("\n");
}

/** 选取近期对话片段，供规划器理解指代（如「那个文件」） */
function buildPlannerDialogueExcerpt(
  dialogue: ReadonlyArray<{ role: string; content: string }>,
  maxChars: number,
): string {
  const tail = dialogue.slice(-6);
  const lines: string[] = [];
  let bytes = 0;
  for (const m of tail) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const role = m.role === "user" ? "用户" : "助手";
    const text = clipText(typeof m.content === "string" ? m.content : "", 1200);
    const line = `${role}: ${text}`;
    const b = Buffer.byteLength(line, "utf8") + 2;
    if (bytes + b > maxChars) break;
    bytes += b;
    lines.push(line);
  }
  return lines.join("\n\n");
}

export function buildPlannerUserContent(options: {
  userMessage: string;
  listed: Awaited<ReturnType<McpPool["listTools"]>>;
  limits: ChatMcpPayloadLimits;
  /** 近期 user/assistant 文本，用于指代消解 */
  dialogue: ReadonlyArray<{ role: string; content: string }>;
}): string {
  const tools = buildPlannerToolsHint(options.listed, options.limits);
  const excerpt = buildPlannerDialogueExcerpt(options.dialogue, 6000);
  const parts = [
    `【当前用户问题】\n${options.userMessage}`,
    `【可用 MCP 工具】\n${tools}`,
  ];
  if (excerpt) {
    parts.push(`【近期对话】\n${excerpt}`);
  }
  return parts.join("\n\n");
}

function extractFirstFencedJsonBlock(text: string): string | null {
  const m = text.match(/```(?:json)?\s*\r?\n([\s\S]*?)```/i);
  const body = m?.[1]?.trim();
  return body && body.length > 0 ? body : null;
}

function normalizePlanSteps(raw: unknown): McpPlanStep[] | null {
  if (!raw || typeof raw !== "object") return null;
  const steps = (raw as { steps?: unknown }).steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const out: McpPlanStep[] = [];
  for (const s of steps) {
    if (!s || typeof s !== "object") return null;
    const o = s as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const goal = typeof o.goal === "string" ? o.goal.trim() : "";
    if (!id || !goal) return null;
    const notes = typeof o.notes === "string" && o.notes.trim() ? o.notes.trim() : undefined;
    out.push({ id, goal, notes });
  }
  return out;
}

/**
 * 从规划模型输出中解析 MCP 多步计划；失败返回 null（调用方回退单段代码路径）。
 */
export function parseMcpPlanFromModelText(text: string): McpPlan | null {
  const fenced = extractFirstFencedJsonBlock(text);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced);
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);

  for (const c of candidates) {
    try {
      const json = JSON.parse(c) as unknown;
      const steps = normalizePlanSteps(json);
      if (steps) return { steps };
    } catch {
      /* try next */
    }
  }
  return null;
}

export function plannerSystemPrompt(): string {
  return MCP_PLANNER_SYSTEM;
}
