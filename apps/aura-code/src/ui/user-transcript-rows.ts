import stringWidth from "string-width";

const graphemeSeg = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(s: string): string[] {
  return [...graphemeSeg.segment(s)].map((x) => x.segment);
}

/** ChatApp paddingX=1（两侧）+ MessageCard「● 」两格 */
export function userMessageInnerWidth(columns: number): number {
  return Math.max(8, columns - 4);
}

function tightenTranscriptBody(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/(?:\n[ \t]*){2,}/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function padRowToInnerWidth(row: string, innerWidth: number): string {
  const w = stringWidth(row);
  if (w >= innerWidth) return row;
  return row + " ".repeat(innerWidth - w);
}

/** 一段逻辑行按终端显示宽折行，优先在空格处断开 */
export function wrapLogicalLine(line: string, maxWidth: number): string[] {
  if (maxWidth < 1) return line.length > 0 ? [line] : [];
  if (stringWidth(line) <= maxWidth) return [line];

  const rows: string[] = [];
  let rest = line;

  while (rest.length > 0) {
    if (stringWidth(rest) <= maxWidth) {
      rows.push(rest);
      break;
    }

    const segs = graphemes(rest);
    let acc = "";
    let accW = 0;
    let i = 0;
    let lastSpaceI = -1;

    for (; i < segs.length; i++) {
      const g = segs[i];
      const gw = stringWidth(g);
      if (accW + gw > maxWidth) break;
      if (g === " " || g === "\t") lastSpaceI = i;
      acc += g;
      accW += gw;
    }

    if (i < segs.length && lastSpaceI >= 0) {
      const head = segs.slice(0, lastSpaceI + 1).join("").trimEnd();
      const tail = segs.slice(lastSpaceI + 1).join("");
      if (head.length > 0) {
        rows.push(head);
        rest = tail.replace(/^\s+/, "");
        continue;
      }
    }

    if (acc.length === 0 && segs.length > 0) {
      acc = segs[0] ?? "";
      i = 1;
    }
    rows.push(acc);
    rest = segs.slice(i).join("").replace(/^\s+/, "");
  }

  return rows;
}

/** 与 tightenTranscriptText 一致的空行过滤后，折行并右补空格至满 inner 宽 */
export function buildUserTranscriptPaddedRows(
  text: string,
  columns: number,
): string[] {
  const inner = userMessageInnerWidth(columns);
  const body = tightenTranscriptBody(text);
  const logicalLines = body
    .split("\n")
    .filter((ln) => ln.trim().length > 0);

  const visual: string[] = [];
  for (const logical of logicalLines) {
    for (const row of wrapLogicalLine(logical, inner)) {
      visual.push(padRowToInnerWidth(row, inner));
    }
  }
  return visual;
}
