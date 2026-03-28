import type { SessionMemory } from "./chat-types.js";

/**
 * 组装发给模型的单条 system：基础人设 + 可选「用户级长期要点」+ 会话级「长期要点」+ 可选「会话前期摘要」；
 * 近期逐字对话放在 messages 的 user/assistant 中，不在此函数内。
 */
export function buildSystemContent(
  session: Pick<SessionMemory, "summary" | "facts">,
  systemPrompt: string,
  /** 跨所有会话共享的用户级事实（每行一条）；与 `session.facts` 区分 */
  userFacts?: string,
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
  return blocks.join("\n\n");
}
