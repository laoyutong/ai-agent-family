/** 粗算 token 数（约 4 字符 ≈ 1 token），后续可换 tiktoken */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
