import type { SessionMemory } from "./chat-types.js";

/**
 * 组装发给模型的单条 system：基础人设 + 可选「长期要点」+ 可选「会话前期摘要」；
 * 近期逐字对话放在 messages 的 user/assistant 中，不在此函数内。
 */
export function buildSystemContent(
  session: Pick<SessionMemory, "summary" | "facts">,
  systemPrompt: string,
): string {
  const blocks: string[] = [systemPrompt];
  if (session.facts?.trim()) {
    blocks.push(`【长期要点】（事实、偏好、约定与专有名词；每行一条）\n${session.facts.trim()}`);
  }
  if (session.summary?.trim()) {
    blocks.push(`【会话前期摘要】（已结束话题的叙事脉络）\n${session.summary.trim()}`);
  }
  return blocks.join("\n\n");
}
