/**
 * 聊天 SSE 与 bot 流式输出的统一片段类型（MCP 阶段 + 正文）。
 */

export type ChatStreamPhase =
  | "mcp_planning"
  | "mcp_codegen"
  | "mcp_tools"
  | "mcp_summarizing";

export type ChatStreamPart =
  | { type: "phase"; phase: ChatStreamPhase }
  | { type: "text"; text: string };

/** 将服务端 phase 枚举展示为短文案（未知值时回退为通用处理中） */
export function phaseLabel(phase: string): string {
  switch (phase) {
    case "mcp_planning":
      return "正在规划工具步骤…";
    case "mcp_codegen":
      return "正在生成工具调用方案…";
    case "mcp_tools":
      return "正在调用工具，请稍候…";
    case "mcp_summarizing":
      return "正在整理答复…";
    default:
      return "处理中…";
  }
}
