/** 读取环境变量为无符号整数；未设置或非法时返回默认值 */
export function parseIntEnv(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

/** 读取环境变量为布尔语义（1/true/on 等）；未设置时返回 defaultValue */
export function parseEnvBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return defaultValue;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  return defaultValue;
}

/** 记忆、裁切、摘要、熵过滤等行为参数（均由环境变量驱动，带默认值） */
export type MemoryChatbotBehaviorConfig = {
  maxHistoryPairs: number;
  summarizeOnTrim: boolean;
  incrementalSummaryEveryNPairs: number;
  entropyPerplexityFilter: boolean;
  entropyFilterMinChars: number;
  entropyFilterMaxTokens: number;
  /** 熵过滤非流式调用所用模型，默认同主对话模型 */
  entropyFilterModel: string;
};

/** 从环境变量加载记忆/裁切/摘要/熵过滤等行为配置（含默认值） */
export function loadMemoryChatbotBehaviorConfig(
  defaultModel: string,
): MemoryChatbotBehaviorConfig {
  return {
    maxHistoryPairs: parseIntEnv("CHAT_HISTORY_MAX_PAIRS", 30),
    summarizeOnTrim: parseEnvBool("CHAT_HISTORY_SUMMARIZE", true),
    incrementalSummaryEveryNPairs: parseIntEnv("CHAT_INCREMENTAL_SUMMARY_EVERY_N_PAIRS", 5),
    entropyPerplexityFilter: parseEnvBool("CHAT_CONTEXT_ENTROPY_PPL_FILTER", true),
    entropyFilterMinChars: parseIntEnv("CHAT_CONTEXT_ENTROPY_PPL_MIN_CHARS", 1800),
    entropyFilterMaxTokens: parseIntEnv("CHAT_CONTEXT_ENTROPY_PPL_MAX_TOKENS", 8192),
    entropyFilterModel: process.env.CHAT_CONTEXT_ENTROPY_PPL_MODEL?.trim() || defaultModel,
  };
}
