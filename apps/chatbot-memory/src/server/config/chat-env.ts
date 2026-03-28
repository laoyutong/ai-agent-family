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

/** `relevant`：按本轮用户输入与归档正文做 lexical 重合打分，只注入分最高的前 N 条 */
export type FoldArchiveInjectSelectMode = "relevant" | "recent";

/** lexical 全为 0 时：回退为按时间取最近几条，或本轮不注入归档 */
export type FoldArchiveInjectRelevanceFallback = "recent" | "none";

/** 将磁盘折叠归档节选写入每轮 system 的上限（见 `buildFoldArchiveInjectBlock`） */
export type FoldArchiveInjectConfig = {
  /** 是否把归档拼进模型 system（归档功能开启时默认可用；可用 `false` 关闭以省 token） */
  enabled: boolean;
  /** 最多包含几条归档批次（`relevant` 为分最高的前 N 条；`recent` 为从新到旧前 N 条） */
  maxEntries: number;
  /** 整段「归档节选」总字符上限 */
  maxTotalChars: number;
  /** 每条归档内「原文节选」字符上限 */
  turnsMaxCharsPerEntry: number;
  selectMode: FoldArchiveInjectSelectMode;
  relevanceFallback: FoldArchiveInjectRelevanceFallback;
};

function parseFoldArchiveInjectSelectMode(): FoldArchiveInjectSelectMode {
  const v = process.env.CHAT_FOLD_ARCHIVE_INJECT_SELECT?.trim().toLowerCase();
  if (v === "recent" || v === "time" || v === "latest") return "recent";
  return "relevant";
}

function parseFoldArchiveInjectRelevanceFallback(): FoldArchiveInjectRelevanceFallback {
  const v = process.env.CHAT_FOLD_ARCHIVE_INJECT_RELEVANCE_FALLBACK?.trim().toLowerCase();
  if (v === "none" || v === "off" || v === "empty") return "none";
  return "recent";
}

export function loadFoldArchiveInjectConfig(): FoldArchiveInjectConfig {
  return {
    enabled: parseEnvBool("CHAT_FOLD_ARCHIVE_INJECT", true),
    maxEntries: parseIntEnv("CHAT_FOLD_ARCHIVE_INJECT_MAX_ENTRIES", 6),
    maxTotalChars: parseIntEnv("CHAT_FOLD_ARCHIVE_INJECT_MAX_CHARS", 12000),
    turnsMaxCharsPerEntry: parseIntEnv("CHAT_FOLD_ARCHIVE_INJECT_TURNS_MAX_CHARS", 3500),
    selectMode: parseFoldArchiveInjectSelectMode(),
    relevanceFallback: parseFoldArchiveInjectRelevanceFallback(),
  };
}
