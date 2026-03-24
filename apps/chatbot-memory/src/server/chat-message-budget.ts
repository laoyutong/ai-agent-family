/** OpenAI 兼容 messages 中、用于体积控制的行（role + content） */
export type ChatBudgetMessage = {
  role: string;
  content?: string | null;
};

/** 缩小 messages：优先删掉最早的一对 user/assistant，保留 system 与最后一条 user */
export function trimMessagesForByteBudget<T extends ChatBudgetMessage>(messages: T[], maxBytes: number): T[] {
  const m = messages.map((row) => ({ ...row }));
  const size = () => Buffer.byteLength(JSON.stringify(m), "utf8");
  while (size() > maxBytes && m.length > 2) {
    if (m[0]?.role === "system" && m[1]?.role === "user" && m[2]?.role === "assistant") {
      m.splice(1, 2);
      continue;
    }
    m.splice(1, 1);
  }
  if (size() > maxBytes && m.length >= 2 && m[0]?.role === "system") {
    const u = m[1];
    if (u?.role === "user" && typeof u.content === "string" && u.content.length > 8000) {
      u.content = `${u.content.slice(0, 8000)}…\n[已截断：当前用户消息过长]`;
    }
  }
  return m;
}

/** messages 膨胀时：将较早的 assistant 正文替换为占位，仍超限则 trim */
export function squeezeMessagesForByteBudget<T extends ChatBudgetMessage>(messages: T[], maxBytes: number): void {
  const bytes = () => Buffer.byteLength(JSON.stringify(messages), "utf8");
  let guard = 0;
  while (bytes() > maxBytes && guard++ < 2000) {
    const idx = messages.findIndex((x, i) => i > 0 && x.role === "assistant");
    if (idx === -1) break;
    const row = messages[idx]!;
    const prevLen = (row.content ?? "").length;
    messages[idx] = { ...row, content: `[已省略早前助手输出（原约 ${prevLen} 字符）]` } as T;
  }
  if (bytes() > maxBytes) {
    const t = trimMessagesForByteBudget(messages, maxBytes);
    messages.length = 0;
    messages.push(...t);
  }
}
