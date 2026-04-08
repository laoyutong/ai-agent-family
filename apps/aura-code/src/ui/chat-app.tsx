import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";
import type { ChatMessage } from "../services/llm/types.js";
import {
  buildAssistantTurnBlocks,
  splitStepLogIntoToolGroups,
  type AssistantTurnBlock,
} from "../engine/assistant-turn-blocks.js";
import { runWithTools } from "../engine/run-with-tools.js";
import type { AgentStep } from "../engine/status-step.js";
import {
  buildAgentSystem,
  isAbortError,
  type ReplOptions,
} from "./session-options.js";
import { InfoPanel } from "./info-panel.js";
import { ReplInputFooter } from "./repl-input-footer.js";
import { RESIZE_SETTLE_MS } from "./stable-stdout.js";
import { theme } from "./theme.js";
import { buildUserTranscriptPaddedRows } from "./user-transcript-rows.js";

const MemoInfoPanel = memo(InfoPanel);

/** 流式正文行 + 可选光标；无正文则不渲染（避免 ◆ 独占一行或空行占位） */
const StreamSegmentLine = memo(function StreamSegmentLine(props: {
  text: string;
  showCursor: boolean;
}): React.JSX.Element | null {
  const body = tightenTranscriptText(props.text);
  if (body.length === 0) {
    return null;
  }
  return (
    <Box
      flexDirection="row"
      alignItems="flex-start"
      width="100%"
      gap={0}
      rowGap={0}
      columnGap={0}
    >
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="wrap" color={theme.assistant}>
          {body}
        </Text>
      </Box>
      {props.showCursor ? (
        <Box flexShrink={0}>
          <Text color={theme.hint}>▍</Text>
        </Box>
      ) : null}
    </Box>
  );
});

function hasStreamText(seg: string | undefined): boolean {
  return tightenTranscriptText(seg ?? "").length > 0;
}

/**
 * 收紧模型输出：统一换行符、合并连续空行、去行尾空白。
 * 避免 `\r\n`/嵌套 `\n` 在 Ink 里被量成「多一行高度」从而在终端里显得行距很大。
 */
function tightenTranscriptText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/(?:\n[ \t]*){2,}/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** 用户历史：按列宽折行，行尾补空格使背景在可视行上拉满；底色仅在有字符的 Text 行上 */
const UserTranscriptLines = memo(function UserTranscriptLines(props: {
  text: string;
}): React.JSX.Element | null {
  const { stdout } = useStdout();
  const [, layoutBump] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        layoutBump((n) => n + 1);
      }, RESIZE_SETTLE_MS + 10);
    };
    stdout.on("resize", onResize);
    return () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const cols = stdout.columns ?? 80;
  const rows = useMemo(
    () => buildUserTranscriptPaddedRows(props.text, cols),
    [props.text, cols, layoutBump],
  );

  if (rows.length === 0) return null;
  return (
    <Box
      flexDirection="column"
      gap={0}
      rowGap={0}
      columnGap={0}
      width="100%"
    >
      {rows.map((row, i) => (
        <Text
          key={i}
          color={theme.user}
          backgroundColor={theme.userMessageTint}
        >
          {row}
        </Text>
      ))}
    </Box>
  );
});

type TranscriptItem = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /**
   * 各段正文（穿插顺序：非空首段 → 工具步骤 → 其余段）；首段可为 "" 表示「先工具后文」。
   * 无工具且仅一段时可省略，用 `text` 即可。
   * @deprecated 新会话用 `assistantBlocks`
   */
  assistantBodySegments?: string[];
  /** 按时间穿插：模型正文块与工具块交替（优先于 assistantBodySegments + steps） */
  assistantBlocks?: AssistantTurnBlock[];
  /** @deprecated 新会话用 `assistantBlocks` */
  steps?: AgentStep[];
};

/** Ink 每棵树只保留一个 staticNode；首项为常驻顶栏，其后为已结束轮次 */
type StaticFeedItem =
  | { kind: "intro" }
  | (TranscriptItem & { kind: "turn" });

export type ChatAppProps = {
  mode: "repl" | "single";
  options: ReplOptions;
  singlePrompt?: string;
};

/** 仅有「轮次分隔」、尚无工具步骤时跳过步骤区，避免空白 */
function hasRenderableAgentSteps(steps: AgentStep[]): boolean {
  return steps.some((s) => s.tone !== "round");
}

/**
 * 是否用「首段/中段工具/后段」穿插布局：多段正文，或单段但本轮有工具（避免单段时画成「全文在上、工具在下」错位）。
 */
function useInterleavedAssistantLayout(row: TranscriptItem): boolean {
  const segs = row.assistantBodySegments;
  if (!segs || segs.length === 0) return false;
  if (segs.length > 1) return true;
  return Boolean(
    row.steps &&
      row.steps.length > 0 &&
      hasRenderableAgentSteps(row.steps),
  );
}

/** Spinner 文案与步骤列表重复（步骤里已有运行态/并行说明）时省略第二行 */
function phaseDuplicatesStepPanel(phaseHint: string, hasSteps: boolean): boolean {
  if (!hasSteps) return false;
  const t = phaseHint.trim();
  return t.includes("· 运行") || /^并行 \d+ 个工具$/.test(t);
}

type SegmentKind = "model" | "tools";

/** 每一段助手输出单独一块；连续多段工具之间不加空行（model↔tool 仍隔开） */
function AssistantSegmentCard(props: {
  index: number;
  kind: SegmentKind;
  prevKind: SegmentKind | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const gapTop =
    props.index > 0 &&
    !(props.prevKind === "tools" && props.kind === "tools")
      ? 1
      : 0;
  return (
    <Box marginTop={gapTop} width="100%">
      <MessageCard
        role="assistant"
        assistantVariant={props.kind === "tools" ? "tools" : "content"}
      >
        {props.children}
      </MessageCard>
    </Box>
  );
}

/** 工具步骤列表（外层 MessageCard 仅 ◇ 与模型 ◆ 不同） */
const AssistantStepsBlock = memo(function AssistantStepsBlock(props: {
  steps: AgentStep[];
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      gap={0}
      rowGap={0}
      columnGap={0}
      marginBottom={0}
      width="100%"
    >
      <AgentStepList steps={props.steps} compact />
    </Box>
  );
});

const MessageCard = memo(function MessageCard(props: {
  role: "user" | "assistant";
  /** 助手：模型正文 ◆ / 工具块 ◇ */
  assistantVariant?: "content" | "tools";
  children: React.ReactNode;
}): React.JSX.Element {
  const isUser = props.role === "user";
  const isToolAssistant =
    props.role === "assistant" && props.assistantVariant === "tools";
  const accent = isUser ? theme.user : theme.assistant;
  const glyph = isUser ? "●" : isToolAssistant ? "◇" : "◆";
  return (
    <Box
      flexDirection="row"
      alignItems="flex-start"
      width="100%"
      minWidth={0}
      paddingY={0}
    >
      <Box flexShrink={0}>
        <Text color={accent} bold>
          {glyph}
        </Text>
      </Box>
      <Text> </Text>
      <Box
        flexGrow={1}
        flexShrink={1}
        flexDirection="column"
        gap={0}
        rowGap={0}
        columnGap={0}
        width="100%"
        minWidth={0}
        paddingY={0}
      >
        {props.children}
      </Box>
    </Box>
  );
});

function stepToneStyle(tone: AgentStep["tone"]) {
  switch (tone) {
    case "invoke":
      return { glyph: "", color: theme.assistant };
    case "done":
      return { glyph: "✓ ", color: theme.assistant };
    case "fail":
      return { glyph: "✗ ", color: theme.error };
    case "round":
      return { glyph: "", color: theme.userMuted };
    case "note":
    default:
      return { glyph: "· ", color: theme.hint };
  }
}

/** 与 tightenTranscriptText 一致；工具回包常带多空行，易把条目「撑开」 */
function softenToolBody(text: string): string {
  return tightenTranscriptText(text);
}

/** 详情/结果挂在 title 下时统一左缩进（避免多一层 Box 拉高 flex 行距） */
function indentSubBlock(text: string, spaces: string): string {
  const t = softenToolBody(text);
  if (!t) return t;
  return t
    .split("\n")
    .map((line) => spaces + line)
    .join("\n");
}

/** 工具标题内换行易在终端里顶出「空行」，压成单行展示 */
function toolTitleOneLine(s: string): string {
  return softenToolBody(s).replace(/\n+/g, " ").trim();
}

const SUB_INDENT = "  ";

const AgentStepList = memo(function AgentStepList({
  steps,
  compact = false,
}: {
  steps: AgentStep[];
  compact?: boolean;
}): React.JSX.Element {
  const visible = steps
    .map((step, i) => ({ step, i }))
    .filter(({ step }) => step.tone !== "round");

  return (
    <Box
      flexDirection="column"
      gap={0}
      rowGap={0}
      columnGap={0}
      marginBottom={compact ? 0 : 1}
      width="100%"
    >
      {visible.map(({ step, i }) => {
        const { glyph, color } = stepToneStyle(step.tone);
        const outcomeErr =
          step.outcome &&
          (/^执行结果：错误：/.test(step.outcome) ||
            step.outcome.trimStart().startsWith("错误："));
        const rowKey = `${step.toolCallId ?? "s"}-${i}`;
        return (
          <Box
            key={rowKey}
            flexDirection="column"
            gap={0}
            rowGap={0}
            columnGap={0}
            width="100%"
            marginTop={0}
            marginBottom={0}
            paddingY={0}
          >
            <Box flexGrow={1} flexShrink={1} width="100%">
              <Text wrap="wrap" color={color}>
                {glyph}
                {toolTitleOneLine(step.title)}
              </Text>
            </Box>
            {step.detail &&
            indentSubBlock(step.detail, SUB_INDENT).length > 0 ? (
              <Text dimColor wrap="wrap">
                {indentSubBlock(step.detail, SUB_INDENT)}
              </Text>
            ) : null}
            {step.outcome &&
            indentSubBlock(step.outcome, SUB_INDENT).length > 0 ? (
              outcomeErr ? (
                <Text color={theme.error} wrap="wrap">
                  {indentSubBlock(step.outcome, SUB_INDENT)}
                </Text>
              ) : (
                <Text wrap="wrap" color={theme.assistant}>
                  {indentSubBlock(step.outcome, SUB_INDENT)}
                </Text>
              )
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
});

export function ChatApp({
  mode,
  options,
  singlePrompt = "",
}: ChatAppProps): React.JSX.Element {
  const { exit } = useApp();
  const cwd = options.cwd ?? process.cwd();
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const messagesRef = useRef<ChatMessage[]>([
    { role: "system", content: buildAgentSystem(options.systemPrompt, cwd) },
  ]);
  const [busy, setBusy] = useState(mode === "single");
  /** 当前用户轮内各次模型回复的流式正文分段（不合并；工具后的正文在步骤下方另起一段） */
  const [streamSegments, setStreamSegments] = useState<string[]>([]);
  /**
   * 本段流式开始时：若当前用户轮内已经有过工具步骤，则这一段是「工具之后的正文」，
   * 布局应为 步骤 → 正文（而非 正文 → 步骤）。
   */
  const postToolsFirstSegmentRef = useRef(false);
  /** 进行中时 Spinner 旁的简短说明（不含工具全文） */
  const [phaseHint, setPhaseHint] = useState("处理中…");
  /** 合并展示：轮次分隔 / 失败条目 + 当前正在执行的工具（单行） */
  const [stepLog, setStepLog] = useState<AgentStep[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stepLogRef = useRef<AgentStep[]>([]);
  const runningToolStepRef = useRef<AgentStep | null>(null);
  const idSeq = useRef(0);
  const startedSingle = useRef(false);

  const nextId = (): string => {
    idSeq.current += 1;
    return `t-${idSeq.current}`;
  };

  const runGeneration = useCallback(
    async (userText: string): Promise<void> => {
      setErrorBanner(null);
      const turnStartLen = messagesRef.current.length;
      messagesRef.current.push({ role: "user", content: userText });
      setItems((prev) => [
        ...prev,
        { id: nextId(), role: "user", text: userText },
      ]);
      setBusy(true);
      setStreamSegments([]);
      postToolsFirstSegmentRef.current = false;
      stepLogRef.current = [];
      runningToolStepRef.current = null;
      setStepLog([]);
      setPhaseHint("处理中…");
      const ac = new AbortController();
      abortRef.current = ac;

      try {
        const { assistantText, error } = await runWithTools({
          chatUrl: options.chatUrl,
          apiKey: options.apiKey,
          model: options.model,
          messages: messagesRef.current,
          cwd,
          signal: ac.signal,
          onStatus: ({ spinnerHint, step }) => {
            setPhaseHint(spinnerHint);
            if (step) {
              if (step.tone === "round" || step.tone === "fail") {
                runningToolStepRef.current = null;
                stepLogRef.current.push(step);
              } else if (
                step.tone === "invoke" &&
                (step.outcome !== undefined || step.invokeComplete)
              ) {
                runningToolStepRef.current = null;
                if (step.toolCallId) {
                  const idx = stepLogRef.current.findIndex(
                    (s) => s.toolCallId === step.toolCallId,
                  );
                  if (idx >= 0) {
                    stepLogRef.current[idx] = step;
                  } else {
                    stepLogRef.current.push(step);
                  }
                } else {
                  stepLogRef.current.push(step);
                }
              } else {
                runningToolStepRef.current = step;
              }
            } else {
              runningToolStepRef.current = null;
            }
            setStepLog([
              ...stepLogRef.current,
              ...(runningToolStepRef.current
                ? [runningToolStepRef.current]
                : []),
            ]);
          },
          /** 仅在不完整 tool_calls 需非流式补全时由引擎触发，清空当前段不可靠片段 */
          onStreamReset: () => {
            setStreamSegments((prev) => {
              if (prev.length === 0) return [];
              const next = [...prev];
              next[next.length - 1] = "";
              return next;
            });
          },
          onStreamSegmentStart: () => {
            setStreamSegments((prev) => {
              const toolsAlready =
                hasRenderableAgentSteps(stepLogRef.current) ||
                runningToolStepRef.current != null;
              postToolsFirstSegmentRef.current = prev.length === 0 && toolsAlready;
              return [...prev, ""];
            });
          },
          onStreamDelta: (chunk) => {
            setStreamSegments((prev) => {
              if (prev.length === 0) return [chunk];
              const next = [...prev];
              next[next.length - 1] = (next[next.length - 1] ?? "") + chunk;
              return next;
            });
          },
        });
        const assistantBlocks = buildAssistantTurnBlocks(
          messagesRef.current,
          turnStartLen,
        );
        const transcriptText =
          assistantBlocks
            .filter((b): b is { kind: "text"; text: string } => b.kind === "text")
            .map((b) => b.text)
            .join("\n\n") || assistantText;
        const hasToolBlocks = assistantBlocks.some((b) => b.kind === "tools");
        setItems((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: transcriptText,
            assistantBlocks: hasToolBlocks ? assistantBlocks : undefined,
          },
        ]);
        // 轮次耗尽等：assistant 气泡已与 error 全文一致，不再叠一条红色框避免重复
        if (error && error.trim() !== transcriptText.trim()) {
          setErrorBanner(error);
        }
      } catch (e) {
        messagesRef.current = messagesRef.current.slice(0, turnStartLen);
        setItems((prev) => prev.slice(0, -1));
        if (!isAbortError(e)) {
          setErrorBanner(e instanceof Error ? e.message : String(e));
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        setPhaseHint("");
        setStreamSegments([]);
        stepLogRef.current = [];
        runningToolStepRef.current = null;
        setStepLog([]);
      }
    },
    [options.apiKey, options.chatUrl, options.model, cwd],
  );

  useInput(
    (_input, key) => {
      if (key.ctrl && _input === "c") {
        if (busy && abortRef.current) {
          abortRef.current.abort();
        } else {
          exit();
        }
      }
    },
    { isActive: true },
  );

  useEffect(() => {
    if (mode !== "single" || startedSingle.current) return;
    const text = singlePrompt.trim();
    if (!text) return;
    startedSingle.current = true;
    void (async () => {
      try {
        await runGeneration(text);
      } finally {
        exit();
      }
    })();
  }, [mode, singlePrompt, runGeneration, exit]);

  const handleSubmitLine = useCallback(
    (value: string): void => {
      if (busy || mode === "single") return;
      const t = value.trim();
      if (!t) return;
      if (t === "exit" || t === "quit") {
        exit();
        return;
      }
      void runGeneration(t);
    },
    [busy, mode, exit, runGeneration],
  );

  const handleSubmitLineRef = useRef(handleSubmitLine);
  handleSubmitLineRef.current = handleSubmitLine;
  const stableOnSubmitLine = useCallback((line: string) => {
    handleSubmitLineRef.current(line);
  }, []);

  const staticFeed = useMemo((): StaticFeedItem[] => {
    return [
      { kind: "intro" },
      ...items.map((row) => ({ kind: "turn" as const, ...row })),
    ];
  }, [items]);

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      gap={0}
      rowGap={0}
      columnGap={0}
      width="100%"
    >
      <Static items={staticFeed}>
        {(row) =>
          row.kind === "intro" ? (
            <MemoInfoPanel key="__info__" model={options.model} cwd={cwd} />
          ) : row.role === "user" ? (
            <MessageCard key={row.id} role="user">
              <UserTranscriptLines text={row.text} />
            </MessageCard>
          ) : (
            <Box key={row.id} flexDirection="column" width="100%" gap={0}>
              {row.assistantBlocks && row.assistantBlocks.length > 0 ? (
                row.assistantBlocks.map((b, i) => {
                  const kind: SegmentKind =
                    b.kind === "text" ? "model" : "tools";
                  const prevKind: SegmentKind | null =
                    i === 0
                      ? null
                      : row.assistantBlocks![i - 1]!.kind === "text"
                        ? "model"
                        : "tools";
                  return (
                    <AssistantSegmentCard
                      key={`${row.id}-ab-${i}`}
                      index={i}
                      kind={kind}
                      prevKind={prevKind}
                    >
                      {b.kind === "text" ? (
                        <StreamSegmentLine
                          text={b.text}
                          showCursor={false}
                        />
                      ) : (
                        <AssistantStepsBlock steps={b.steps} />
                      )}
                    </AssistantSegmentCard>
                  );
                })
              ) : useInterleavedAssistantLayout(row) ? (
                (() => {
                  const segs = row.assistantBodySegments ?? [];
                  type Piece = {
                    key: string;
                    kind: SegmentKind;
                    node: React.ReactNode;
                  };
                  const pieces: Piece[] = [];
                  if ((segs[0] ?? "").trim().length > 0) {
                    pieces.push({
                      key: `${row.id}-s0`,
                      kind: "model",
                      node: (
                        <StreamSegmentLine
                          text={segs[0] ?? ""}
                          showCursor={false}
                        />
                      ),
                    });
                  }
                  if (
                    row.steps &&
                    row.steps.length > 0 &&
                    hasRenderableAgentSteps(row.steps)
                  ) {
                    pieces.push({
                      key: `${row.id}-st`,
                      kind: "tools",
                      node: <AssistantStepsBlock steps={row.steps} />,
                    });
                  }
                  segs.slice(1).forEach((seg, j) => {
                    pieces.push({
                      key: `${row.id}-s${j + 1}`,
                      kind: "model",
                      node: (
                        <StreamSegmentLine
                          text={seg}
                          showCursor={false}
                        />
                      ),
                    });
                  });
                  return pieces.map((p, i) => (
                    <AssistantSegmentCard
                      key={p.key}
                      index={i}
                      kind={p.kind}
                      prevKind={i === 0 ? null : pieces[i - 1]!.kind}
                    >
                      {p.node}
                    </AssistantSegmentCard>
                  ));
                })()
              ) : (
                <>
                  <AssistantSegmentCard
                    index={0}
                    kind="model"
                    prevKind={null}
                  >
                    <Box flexDirection="column" gap={0} width="100%">
                      <Text wrap="wrap" color={theme.assistant}>
                        {tightenTranscriptText(row.text)}
                      </Text>
                    </Box>
                  </AssistantSegmentCard>
                  {row.steps &&
                  row.steps.length > 0 &&
                  hasRenderableAgentSteps(row.steps) ? (
                    <AssistantSegmentCard
                      index={1}
                      kind="tools"
                      prevKind="model"
                    >
                      <AssistantStepsBlock steps={row.steps} />
                    </AssistantSegmentCard>
                  ) : null}
                </>
              )}
            </Box>
          )
        }
      </Static>

      {busy
        ? (() => {
            const groups = splitStepLogIntoToolGroups(stepLog);
            const S = streamSegments.length;
            const G = groups.length;
            const postFirst = postToolsFirstSegmentRef.current;
            const lastI = S - 1;
            const hasStepsForPhase =
              G > 0 && groups.some((g) => hasRenderableAgentSteps(g));
            const showPhaseRow =
              !phaseDuplicatesStepPanel(phaseHint, hasStepsForPhase);

            type LivePart = { kind: SegmentKind; node: React.ReactNode };
            const pieces: LivePart[] = [];

            if (S === 0) {
              for (let j = 0; j < G; j++) {
                pieces.push({
                  kind: "tools",
                  node: <AssistantStepsBlock steps={groups[j]!} />,
                });
              }
              if (showPhaseRow) {
                pieces.push({
                  kind: "model",
                  node: (
                    <Box
                      flexDirection="row"
                      flexWrap="wrap"
                      alignItems="center"
                      width="100%"
                    >
                      <Text color={theme.assistant}>
                        <Spinner type="dots" />
                      </Text>
                      <Text color={theme.hint} wrap="wrap">
                        {" "}
                        {phaseHint || "处理中…"}
                      </Text>
                    </Box>
                  ),
                });
              }
            } else if (postFirst) {
              const maxJ = Math.max(S, G);
              for (let j = 0; j < maxJ; j++) {
                if (j < G) {
                  pieces.push({
                    kind: "tools",
                    node: <AssistantStepsBlock steps={groups[j]!} />,
                  });
                }
                if (j < S && hasStreamText(streamSegments[j])) {
                  pieces.push({
                    kind: "model",
                    node: (
                      <StreamSegmentLine
                        text={streamSegments[j] ?? ""}
                        showCursor={j === lastI}
                      />
                    ),
                  });
                }
              }
            } else {
              for (let j = 0; j < S; j++) {
                if (hasStreamText(streamSegments[j])) {
                  pieces.push({
                    kind: "model",
                    node: (
                      <StreamSegmentLine
                        text={streamSegments[j] ?? ""}
                        showCursor={j === lastI}
                      />
                    ),
                  });
                }
                if (j < G) {
                  pieces.push({
                    kind: "tools",
                    node: <AssistantStepsBlock steps={groups[j]!} />,
                  });
                }
              }
              for (let j = S; j < G; j++) {
                pieces.push({
                  kind: "tools",
                  node: <AssistantStepsBlock steps={groups[j]!} />,
                });
              }
            }

            return (
              <Box flexDirection="column" width="100%" gap={0}>
                {pieces.map((p, i) => (
                  <AssistantSegmentCard
                    key={`live-seg-${i}`}
                    index={i}
                    kind={p.kind}
                    prevKind={i === 0 ? null : pieces[i - 1]!.kind}
                  >
                    {p.node}
                  </AssistantSegmentCard>
                ))}
              </Box>
            );
          })()
        : null}

      {errorBanner ? (
        <Box
          flexDirection="column"
          marginBottom={0}
          paddingX={1}
          borderStyle="round"
          borderColor={theme.error}
        >
          <Text bold color={theme.error}>
            出错了
          </Text>
          <Text color={theme.error} wrap="wrap">
            {tightenTranscriptText(errorBanner)}
          </Text>
        </Box>
      ) : null}

      {mode === "repl" && !busy ? (
        <ReplInputFooter onSubmitLine={stableOnSubmitLine} />
      ) : null}
    </Box>
  );
}
