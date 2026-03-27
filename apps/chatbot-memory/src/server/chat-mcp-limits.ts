import { parseIntEnv } from "./chat-env.js";

export type ChatMcpPayloadLimits = {
  maxTools: number;
  maxParamBytesPerTool: number;
  maxDescriptionChars: number;
  maxToolsJsonBytes: number;
  /** 整段 messages 序列化后的字节上限（当前为不限制） */
  maxContextJsonBytes: number;
};

const UNLIMITED = Number.MAX_SAFE_INTEGER;

/** 暂不限制 MCP 门面与上下文体积；仅靠上游 API 自身上限。 */
export function loadChatMcpPayloadLimits(): ChatMcpPayloadLimits {
  return {
    maxTools: UNLIMITED,
    maxParamBytesPerTool: UNLIMITED,
    maxDescriptionChars: UNLIMITED,
    maxToolsJsonBytes: UNLIMITED,
    maxContextJsonBytes: UNLIMITED,
  };
}

export function loadMcpCodeSandboxLimits(): { maxMs: number; maxCalls: number } {
  return {
    maxMs: Math.max(500, parseIntEnv("CHAT_MCP_CODE_MAX_MS", 30_000)),
    maxCalls: Math.max(1, parseIntEnv("CHAT_MCP_CODE_MAX_CALLS", 32)),
  };
}
