import type { ChatMessage, FoldArchiveLink } from "./chat-types.js";
import { formatTurnsForSummary } from "./memory-turns.js";
import type { FoldArchiveInjectConfig } from "../config/chat-env.js";
import type { FoldArchiveStore } from "../persistence/fold-archive-store.js";

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (!t) return "";
  if (t.length > max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/** 供 lexical 打分的归档文本（折叠前后摘要 + 对话全文，过长截断） */
const SCORE_DOC_MAX = 14_000;

function buildScoreDocumentText(rec: {
  summaryBefore?: string;
  summaryAfter?: string;
  factsBefore?: string;
  factsAfter?: string;
  turns: ChatMessage[];
}): string {
  const parts = [
    rec.summaryBefore ?? "",
    rec.summaryAfter ?? "",
    rec.factsBefore ?? "",
    rec.factsAfter ?? "",
    formatTurnsForSummary(rec.turns),
  ];
  const full = parts.join("\n").trim();
  return full.length <= SCORE_DOC_MAX ? full : full.slice(0, SCORE_DOC_MAX);
}

/**
 * 从用户当前输入抽取可匹配片段：英文/数字词（≥2）+ 汉字二元组（滑动窗口）。
 */
export function extractMatchTokens(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out = new Set<string>();
  for (const w of q.match(/[a-z0-9]{2,}/gi) ?? []) out.add(w);
  const cjk = q.replace(/[^\u4e00-\u9fff]/g, "");
  const maxWindow = Math.min(cjk.length - 1, 256);
  for (let i = 0; i <= maxWindow; i++) {
    out.add(cjk.slice(i, i + 2));
  }
  if (cjk.length === 1) out.add(cjk);
  return [...out].filter((t) => t.length >= 2);
}

/** 关键词/字二元组在归档正文中的命中得分 */
export function scoreQueryAgainstDoc(query: string, doc: string): number {
  const tokens = extractMatchTokens(query);
  if (!tokens.length || !doc.trim()) return 0;
  const d = doc.toLowerCase();
  let s = 0;
  for (const t of tokens) {
    if (d.includes(t)) {
      if (t.length >= 4) s += 4;
      else if (t.length === 3) s += 3;
      else s += 2;
    }
  }
  return s;
}

function orderRecent(links: FoldArchiveLink[]): FoldArchiveLink[] {
  return [...links].sort((a, b) => b.createdAt - a.createdAt);
}

/** 按 lexical 分排序；全 0 时走 `relevanceFallback` */
function orderByLexical(
  rows: Array<{
    link: FoldArchiveLink;
    rec: NonNullable<Awaited<ReturnType<FoldArchiveStore["get"]>>>;
    doc: string;
    scoreLex: number;
  }>,
  relevanceFallback: FoldArchiveInjectConfig["relevanceFallback"],
): FoldArchiveLink[] {
  const maxScore = Math.max(0, ...rows.map((x) => x.scoreLex));
  if (maxScore <= 0) {
    if (relevanceFallback === "none") return [];
    return orderRecent(rows.map((x) => x.link));
  }
  return [...rows]
    .filter((x) => x.scoreLex > 0)
    .sort((a, b) => {
      if (b.scoreLex !== a.scoreLex) return b.scoreLex - a.scoreLex;
      return b.link.createdAt - a.link.createdAt;
    })
    .map((x) => x.link);
}

/**
 * 按预算从 `foldArchiveLinks` 拉取磁盘归档拼入 system。
 * `selectMode=relevant` 时按 **lexical**（关键词 + 汉字二元组）与归档全文重合度排序。
 */
export async function buildFoldArchiveInjectBlock(
  store: FoldArchiveStore,
  sessionId: string,
  links: FoldArchiveLink[] | undefined,
  limits: Pick<
    FoldArchiveInjectConfig,
    "maxEntries" | "maxTotalChars" | "turnsMaxCharsPerEntry" | "selectMode" | "relevanceFallback"
  >,
  userQuery: string,
): Promise<string | undefined> {
  if (!links?.length) return undefined;

  const loaded = await Promise.all(
    links.map(async (link) => {
      const rec = await store.get(sessionId, link.index);
      return { link, rec };
    }),
  );

  const baseRows = loaded
    .filter((x): x is { link: FoldArchiveLink; rec: NonNullable<(typeof loaded)[number]["rec"]> } => Boolean(x.rec?.turns?.length))
    .map(({ link, rec }) => {
      const doc = buildScoreDocumentText(rec);
      const scoreLex =
        limits.selectMode === "relevant" && userQuery.trim()
          ? scoreQueryAgainstDoc(userQuery, doc)
          : 0;
      return { link, rec, doc, scoreLex };
    });

  if (baseRows.length === 0) return undefined;

  let orderedLinks: FoldArchiveLink[];

  if (limits.selectMode === "recent" || !userQuery.trim()) {
    orderedLinks = orderRecent(baseRows.map((x) => x.link));
  } else {
    orderedLinks = orderByLexical(baseRows, limits.relevanceFallback);
  }

  if (orderedLinks.length === 0) return undefined;

  const byIndex = new Map(baseRows.map((x) => [x.link.index, x] as const));
  const parts: string[] = [];
  let used = 0;
  let n = 0;
  for (const link of orderedLinks) {
    if (n >= limits.maxEntries) break;
    const row = byIndex.get(link.index);
    if (!row?.rec?.turns?.length) continue;
    const { rec } = row;
    n++;
    const modeLabel = link.mode === "incremental" ? "增量摘要" : "超长裁切";
    const lines: string[] = [`### 归档 #${link.index}（${modeLabel}）`];
    const sb = truncate(rec.summaryBefore ?? "", 600);
    const sa = truncate(rec.summaryAfter ?? "", 600);
    if (sb) lines.push(`折叠前会话摘要节选：${sb}`);
    if (sa) lines.push(`该批折叠后会话摘要节选：${sa}`);
    lines.push(`原文节选：\n${truncate(formatTurnsForSummary(rec.turns), limits.turnsMaxCharsPerEntry)}`);
    const chunk = lines.join("\n");
    const sep = parts.length === 0 ? 0 : 2;
    if (used + sep + chunk.length > limits.maxTotalChars) {
      const room = limits.maxTotalChars - used - sep;
      if (room < 80) break;
      parts.push(truncate(chunk, room));
      break;
    }
    parts.push(chunk);
    used += sep + chunk.length;
  }
  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}
