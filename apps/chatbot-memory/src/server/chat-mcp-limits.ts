import { parseIntEnv } from "./chat-env.js";

export type ChatMcpPayloadLimits = {
  maxTools: number;
  maxParamBytesPerTool: number;
  maxDescriptionChars: number;
  maxToolResultChars: number;
  maxToolsJsonBytes: number;
  /** 整段 messages 序列化后的字节上限，防止上下文过大触发 413 */
  maxContextJsonBytes: number;
};

export function loadChatMcpPayloadLimits(): ChatMcpPayloadLimits {
  return {
    maxTools: Math.min(256, Math.max(1, parseIntEnv("CHAT_MCP_MAX_TOOLS", 48))),
    maxParamBytesPerTool: Math.max(256, parseIntEnv("CHAT_MCP_TOOL_PARAM_MAX_BYTES", 6144)),
    maxDescriptionChars: Math.max(80, parseIntEnv("CHAT_MCP_TOOL_DESC_MAX_CHARS", 900)),
    maxToolResultChars: Math.max(1000, parseIntEnv("CHAT_MCP_TOOL_RESULT_MAX_CHARS", 65536)),
    maxToolsJsonBytes: Math.max(50_000, parseIntEnv("CHAT_MCP_TOOLS_JSON_MAX_BYTES", 450_000)),
    maxContextJsonBytes: Math.max(100_000, parseIntEnv("CHAT_MCP_CONTEXT_MAX_JSON_BYTES", 1_200_000)),
  };
}

export function loadMcpCodeSandboxLimits(): { maxMs: number; maxCalls: number } {
  return {
    maxMs: Math.max(500, parseIntEnv("CHAT_MCP_CODE_MAX_MS", 30_000)),
    maxCalls: Math.max(1, parseIntEnv("CHAT_MCP_CODE_MAX_CALLS", 32)),
  };
}
