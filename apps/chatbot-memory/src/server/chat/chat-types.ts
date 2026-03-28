export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** 本会话内「某次折叠 ↔ 归档 index」的强关联（随会话 JSON 持久化） */
export type FoldArchiveLink = {
  index: number;
  mode: "incremental" | "trim";
  createdAt: number;
};

export type SessionMemory = {
  /** 交替 user / assistant，不含 system —— 短期 verbatim，直接进模型上下文 */
  turns: ChatMessage[];
  /** 被裁切部分的叙事脉络（中期压缩） */
  summary?: string;
  /** 从裁切与历史中沉淀的稳定要点：偏好、事实、约定、专有名词等（长期层，每行一条） */
  facts?: string;
  /** 每次成功折叠并归档后的序号与时间轴，与 `fold-archives/:index` 一一对应 */
  foldArchiveLinks?: FoldArchiveLink[];
  /** 后台摘要任务链，保证多轮裁切时按序合并进 summary/facts，避免并发写竞态 */
  foldChain?: Promise<void>;
};
