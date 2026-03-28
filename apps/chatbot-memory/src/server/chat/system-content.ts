import type { SessionMemory } from "./chat-types.js";

/**
 * 组装发给模型的单条 system：基础人设 + 可选「用户级长期要点」+ 会话级「长期要点」+ 可选「会话前期摘要」
 * + 可选「已移出逐轮上下文的归档原文节选」；
 * 近期逐字对话放在 messages 的 user/assistant 中，不在此函数内。
 */
export function buildSystemContent(
  session: Pick<SessionMemory, "summary" | "facts">,
  systemPrompt: string,
  /** 跨所有会话共享的用户级事实（每行一条）；与 `session.facts` 区分 */
  userFacts?: string,
  /** 由 `buildFoldArchiveInjectBlock` 生成；供模型追溯已折叠出窗口的逐字对话 */
  foldArchiveDigest?: string,
): string {
  const blocks: string[] = [systemPrompt];
  if (userFacts?.trim()) {
    blocks.push(
      `【用户级长期要点】（跨会话稳定信息：偏好、称谓、常用语境等；每行一条）\n${userFacts.trim()}`,
    );
  }
  if (session.facts?.trim()) {
    blocks.push(`【本会话长期要点】（事实、偏好、约定与专有名词；每行一条）\n${session.facts.trim()}`);
  }
  if (session.summary?.trim()) {
    blocks.push(`【会话前期摘要】（已结束话题的叙事脉络）\n${session.summary.trim()}`);
  }
  if (foldArchiveDigest?.trim()) {
    blocks.push(
      "【原文归档节选】（以下批次已从逐轮上下文中移出，仅磁盘保留；含当时摘要层节选与对话原文片段，供回答用户追问早期细节时对照。当前消息列表中的 user/assistant 为近期逐字对话。）\n" +
        foldArchiveDigest.trim(),
    );
  }
  return blocks.join("\n\n");
}
