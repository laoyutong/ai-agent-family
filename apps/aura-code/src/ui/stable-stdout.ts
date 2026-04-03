/**
 * 部分终端在出现纵向滚动条时会让 `stdout.columns` / `rows` 在相邻整数间抖动。
 * Ink 在每次 `resize` 上都会跑 `resized()` → `calculateLayout` + `onRender`，并在宽度变窄时
 * `clear()`，表现为整屏来回「跳动」。
 *
 * 另外：Ink 用 `outputHeight >= stdout.rows` 在「增量 log-update」与「清屏重绘」之间切换。
 * 对话/流式输出变长后高度会反复跨阈值，配合滚动条会造成严重视口来回跳；本代理对 `rows`
 * 报告极大占位值，只让 Ink 走增量路径（列宽仍以真实 TTY 为准）。
 *
 * 1. `columns`：小幅变化忽略 + resize 防抖后再通知监听方。
 * 2. `rows`：固定大值；真实行数若需可读可继续用 `process.stdout.rows`。
 */
const DIMENSION_TOLERANCE = 2;

/** 仅供 Ink 判断「是否占满终端」；大于任何合理动态输出行数即可 */
const INK_ROWS_PLACEHOLDER = 1_000_000;

/** 与内部分辨率落定逻辑一致，供 UI 在 resize 后同步重绘（如分隔线宽度） */
export const RESIZE_SETTLE_MS = 100;

export function createLayoutStableStdout(
  base: NodeJS.WriteStream = process.stdout,
): NodeJS.WriteStream {
  let stableCols = base.columns || 80;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 与 Node 一致：有序、可重复注册，`off` 只摘第一个匹配项 */
  const resizeListeners: Array<(...args: unknown[]) => void> = [];

  const notifyResizeListeners = (): void => {
    const snapshot = resizeListeners.slice();
    for (const fn of snapshot) {
      fn();
    }
  };

  const applyStableDimensions = (): boolean => {
    const prevCols = stableCols;
    const nextCols = base.columns || 80;
    if (Math.abs(nextCols - stableCols) > DIMENSION_TOLERANCE) {
      stableCols = nextCols;
    }
    return stableCols !== prevCols;
  };

  const scheduleAfterResize = (): void => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
    }
    settleTimer = setTimeout(() => {
      settleTimer = null;
      const changed = applyStableDimensions();
      if (changed && resizeListeners.length > 0) {
        notifyResizeListeners();
      }
    }, RESIZE_SETTLE_MS);
  };

  base.on("resize", scheduleAfterResize);

  const addResizeListener = (
    listener: (...args: unknown[]) => void,
    prepend: boolean,
  ): void => {
    if (prepend) {
      resizeListeners.unshift(listener);
    } else {
      resizeListeners.push(listener);
    }
  };

  const removeResizeListener = (listener: (...args: unknown[]) => void): void => {
    const i = resizeListeners.indexOf(listener);
    if (i !== -1) {
      resizeListeners.splice(i, 1);
    }
  };

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "columns") {
        return stableCols;
      }
      if (prop === "rows") {
        return INK_ROWS_PLACEHOLDER;
      }
      if (prop === "on" || prop === "addListener") {
        return (
          event: string,
          listener: (...args: unknown[]) => void,
        ): NodeJS.WriteStream => {
          if (event === "resize") {
            addResizeListener(listener, false);
            return receiver as NodeJS.WriteStream;
          }
          return target.on(event, listener);
        };
      }
      if (prop === "prependListener") {
        return (
          event: string,
          listener: (...args: unknown[]) => void,
        ): NodeJS.WriteStream => {
          if (event === "resize") {
            addResizeListener(listener, true);
            return receiver as NodeJS.WriteStream;
          }
          return target.prependListener(event, listener);
        };
      }
      if (prop === "off" || prop === "removeListener") {
        return (
          event: string,
          listener: (...args: unknown[]) => void,
        ): NodeJS.WriteStream => {
          if (event === "resize") {
            removeResizeListener(listener);
            return receiver as NodeJS.WriteStream;
          }
          return target.off(event, listener);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as NodeJS.WriteStream;
}
