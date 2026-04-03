/** Ink / chalk 语义色，便于统一调整视觉风格 */
export const theme = {
  brand: "magenta" as const,
  brandDim: "gray" as const,
  title: "white" as const,
  user: "cyan" as const,
  /** 历史用户消息条底色（终端无 alpha，用略亮的深灰模拟半透明底） */
  userMessageTint: "#363636" as const,
  userMuted: "blue" as const,
  /** 助手正文：亮紫/兰紫（饱和更高，与用户 cyan 区分） */
  assistant: "#c575f5" as const,
  border: "gray" as const,
  borderFocus: "magenta" as const,
  error: "red" as const,
  hint: "gray" as const,
  prompt: "magenta" as const,
  cursor: "gray" as const,
};

export function shortenPath(path: string, maxChars = 56): string {
  const p = path.replace(/^\/Users\/[^/]+/, "~");
  if (p.length <= maxChars) return p;
  const keep = maxChars - 1;
  return `…${p.slice(-keep)}`;
}
