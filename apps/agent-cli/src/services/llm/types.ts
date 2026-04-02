export type ChatRole = "system" | "user" | "assistant" | "tool";

/** OpenAI / DeepSeek chat/completions 消息（非流式响应可含 tool_calls） */
export type ChatMessage = {
  role: ChatRole;
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** OpenAI tools[] 单项（JSON Schema 风格） */
export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type LLMStreamChunk =
  | { type: "text"; text: string }
  | { type: "error"; message: string; status?: number };

export type ChatCompletionResult = {
  message: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason?: string | null;
};
