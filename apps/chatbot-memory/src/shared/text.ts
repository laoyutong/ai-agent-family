/** 按字符数截断并加省略号（用于提示词、日志、API 体积控制） */
export function clipText(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}
