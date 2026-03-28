/** 日志输出用：过长文本截断并标注原长度 */
export function truncateForLog(s: string, maxChars: number): string {
  if (maxChars <= 0 || s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…[日志已截断，全文约 ${s.length} 字符]`;
}

/** 将任意值序列化为单行式日志文本，失败时退化为 String() */
export function stringifyUnknownForLog(value: unknown, maxChars: number): string {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  return truncateForLog(raw, maxChars);
}
