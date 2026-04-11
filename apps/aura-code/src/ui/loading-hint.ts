import { toolApiShortLabel } from "../engine/status-step.js";

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length]!;
}

/**
 * 根据引擎下发的 phase与已等待秒数生成会随时间轮换的说明，避免长时间停在同一句话。
 */
export function buildAnimatedLoadingCaption(
  rawHint: string,
  elapsedSec: number,
): string {
  const t = rawHint.trim();
  /** 约每 2s 换一条，与秒数计时错开一点 */
  const rot = Math.floor(elapsedSec / 2);

  if (!t || t === "处理中…") {
    return pick(
      ["处理中…", "请稍候…", "仍在进行…", "稍等片刻…"] as const,
      rot,
    );
  }

  if (t.includes("请求模型")) {
    return pick(
      [
        "正在请求模型…",
        "等待模型推理…",
        "生成回复中…",
        "流式输出中…",
      ] as const,
      rot,
    );
  }

  const parallel = /^并行 (\d+) 个工具$/.exec(t);
  if (parallel) {
    const n = parallel[1]!;
    return pick(
      [
        `并行执行 ${n} 个工具…`,
        `${n} 个工具同时运行中…`,
        `多路工具 ${n} 项进行中…`,
        `协同执行 ${n} 个工具…`,
      ] as const,
      rot,
    );
  }

  if (t.includes("· 运行")) {
    const apiPart = t.split(" · ")[0]!.trim();
    const zh = toolApiShortLabel(apiPart);
    return pick(
      [`${zh} 运行中…`, `${zh} 执行中…`, `等待 ${zh} 返回…`] as const,
      rot,
    );
  }

  if (t.includes("非流式补全") || t.includes("流式工具结构")) {
    return pick(
      [
        "流式结构不完整 · 改走完整请求…",
        "正在非流式补全…",
        "重新拉取工具调用…",
      ] as const,
      rot,
    );
  }

  if (t.includes("· 完成") || t.includes("· 失败")) {
    return t;
  }

  if (t.startsWith("已达工具")) {
    return t;
  }

  const suffix = elapsedSec >= 3 ? ` · ${elapsedSec}s` : "";
  return `${t}${suffix}`;
}
