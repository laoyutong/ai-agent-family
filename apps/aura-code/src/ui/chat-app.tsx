import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildAnimatedLoadingCaption } from "./loading-hint.js";
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
import type { PendingPermissionRequest } from "../types/index.js";
import { PermissionPrompt, type PermissionChoice } from "./permission-prompt.js";
import { addAllowedTool } from "../engine/permissions.js";

// InfoPanel 已使用 memo 包装

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

/** 工具调用已下发、尚未收到结果（与 invokeComplete / outcome 区分） */
function isAgentStepInvokeRunning(step: AgentStep): boolean {
  return (
    step.tone === "invoke" &&
    step.invokeComplete !== true &&
    step.outcome === undefined
  );
}

/** 底部「Spinner + 阶段说明」；工具执行、补全、等模型时复用 */
const BusyPhaseFooter = memo(function BusyPhaseFooter(props: {
  hint: string;
}): React.JSX.Element {
  const phaseKey = props.hint;
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    setElapsedSec(0);
  }, [phaseKey]);
  useEffect(() => {
    const id = setInterval(() => {
      setElapsedSec((s) => s + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [phaseKey]);
  const label = buildAnimatedLoadingCaption(props.hint, elapsedSec);
  return (
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
        {label}
      </Text>
    </Box>
  );
});

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
        const invokeRunning = isAgentStepInvokeRunning(step);
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
            <Box
              flexDirection="row"
              flexWrap="wrap"
              alignItems="center"
              flexGrow={1}
              flexShrink={1}
              width="100%"
            >
              {invokeRunning ? (
                <Box flexShrink={0} marginRight={1}>
                  <Text color={theme.assistant}>
                    <Spinner type="dots" />
                  </Text>
                </Box>
              ) : null}
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text wrap="wrap" color={color}>
                  {glyph}
                  {toolTitleOneLine(step.title)}
                </Text>
              </Box>
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

  // 使用 ref 存储初始值，确保永远不会变化
  const initialPropsRef = useRef({
    apiKey: options.apiKey,
    chatUrl: options.chatUrl,
    model: options.model,
    cwd: options.cwd ?? process.cwd(),
    systemPrompt: options.systemPrompt,
  });

  const stableOptions = initialPropsRef.current;
  const cwd = stableOptions.cwd;

  // InfoPanel 的 props 单独缓存
  const infoPanelProps = useMemo(
    () => ({
      model: stableOptions.model,
      cwd: stableOptions.cwd,
    }),
    [] // 空依赖数组，只创建一次
  );
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const messagesRef = useRef<ChatMessage[]>([
    { role: "system", content: buildAgentSystem(stableOptions.systemPrompt, cwd) },
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
  /** 权限确认相关状态和 ref */
  const [pendingPermission, setPendingPermission] = useState<PendingPermissionRequest | null>(null);
  const permissionResolveRef = useRef<((allowed: boolean) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stepLogRef = useRef<AgentStep[]>([]);
  const runningToolStepRef = useRef<AgentStep | null>(null);
  const idSeq = useRef(0);
  const startedSingle = useRef(false);

  /** 使用 ref 访问最新状态，避免 useInput 闭包问题 */
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const pendingPermissionRef = useRef(pendingPermission);
  pendingPermissionRef.current = pendingPermission;

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
          chatUrl: stableOptions.chatUrl,
          apiKey: stableOptions.apiKey,
          model: stableOptions.model,
          messages: messagesRef.current,
          cwd,
          signal: ac.signal,
          onStatus: ({ spinnerHint, step }) => {
            setPhaseHint(spinnerHint);
            if (step) {
              if (step.tone === "round" || step.tone === "fail") {
                runningToolStepRef.current = null;
                // 轮次分隔时，清空 stepLog（这些步骤已经被记录到 assistantBlocks 中）
                stepLogRef.current = [];
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
          onRequestPermission: async (request) => {
            return new Promise((resolve) => {
              permissionResolveRef.current = resolve;
              setPendingPermission(request);
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
    [stableOptions.apiKey, stableOptions.chatUrl, stableOptions.model, cwd],
  );

  // 全局 Ctrl+C 退出 - 使用 ref 检查状态避免闭包问题
  useInput(
    (input: string, key: { ctrl: boolean }) => {
      // 忽略鼠标事件序列
      if (input.startsWith("\x1b[") || input.startsWith("\x1b[M")) {
        return;
      }

      // 如果有确认框显示，完全忽略输入
      if (pendingPermissionRef.current) return;

      if (key.ctrl && input === "c") {
        if (busyRef.current && abortRef.current) {
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

  // 流式内容也使用 useMemo 缓存
  // 使用 useRef 缓存已经渲染过的工具步骤，避免重复渲染
  const renderedToolsRef = useRef<Set<string>>(new Set());

  const streamingContent = useMemo(() => {
    if (!busy) {
      // busy 为 false 时清空已渲染工具记录
      renderedToolsRef.current.clear();
      return null;
    }

    const groups = splitStepLogIntoToolGroups(stepLog);
    const S = streamSegments.length;
    const G = groups.length;
    const postFirst = postToolsFirstSegmentRef.current;
    const lastI = S - 1;
    const hasStepsForPhase =
      G > 0 && groups.some((g) => hasRenderableAgentSteps(g));
    const showPhaseRow = !phaseDuplicatesStepPanel(phaseHint, hasStepsForPhase);

    type LivePart = {
      kind: SegmentKind;
      node: React.ReactNode;
      key: string;
    };
    const pieces: LivePart[] = [];

    if (S === 0) {
      for (let j = 0; j < G; j++) {
        const group = groups[j]!;
        const groupKey = group.map(s => s.toolCallId || s.title).join('-');
        pieces.push({
          kind: "tools",
          key: `tools-${groupKey}`,
          node: <AssistantStepsBlock steps={group} />,
        });
      }
      if (showPhaseRow) {
        pieces.push({
          kind: "model",
          key: `phase-${phaseHint}`,
          node: <BusyPhaseFooter hint={phaseHint || "处理中…"} />,
        });
      }
    } else if (postFirst) {
      const maxJ = Math.max(S, G);
      for (let j = 0; j < maxJ; j++) {
        if (j < G) {
          const group = groups[j]!;
          const groupKey = group.map(s => s.toolCallId || s.title).join('-');
          pieces.push({
            kind: "tools",
            key: `tools-${groupKey}`,
            node: <AssistantStepsBlock steps={group} />,
          });
        }
        if (j < S && hasStreamText(streamSegments[j])) {
          pieces.push({
            kind: "model",
            key: `stream-${j}-${streamSegments[j]?.slice(0, 20)}`,
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
            key: `stream-${j}-${streamSegments[j]?.slice(0, 20)}`,
            node: (
              <StreamSegmentLine
                text={streamSegments[j] ?? ""}
                showCursor={j === lastI}
              />
            ),
          });
        }
        if (j < G) {
          const group = groups[j]!;
          const groupKey = group.map(s => s.toolCallId || s.title).join('-');
          pieces.push({
            kind: "tools",
            key: `tools-${groupKey}`,
            node: <AssistantStepsBlock steps={group} />,
          });
        }
      }
      for (let j = S; j < G; j++) {
        const group = groups[j]!;
        const groupKey = group.map(s => s.toolCallId || s.title).join('-');
        pieces.push({
          kind: "tools",
          key: `tools-${groupKey}`,
          node: <AssistantStepsBlock steps={group} />,
        });
      }
    }

    const appendPhaseFooter =
      S > 0 &&
      phaseHint.trim().length > 0 &&
      !phaseDuplicatesStepPanel(phaseHint, hasStepsForPhase);
    const tailIndex = pieces.length;

    return (
      <Box flexDirection="column" width="100%" gap={0}>
        {pieces.map((p, i) => (
          <AssistantSegmentCard
            key={p.key}
            index={i}
            kind={p.kind}
            prevKind={i === 0 ? null : pieces[i - 1]!.kind}
          >
            {p.node}
          </AssistantSegmentCard>
        ))}
        {appendPhaseFooter ? (
          <AssistantSegmentCard
            key={`phase-footer-${phaseHint}`}
            index={tailIndex}
            kind="model"
            prevKind={tailIndex === 0 ? null : pieces[tailIndex - 1]!.kind}
          >
            <BusyPhaseFooter hint={phaseHint} />
          </AssistantSegmentCard>
        ) : null}
      </Box>
    );
  }, [busy, stepLog, streamSegments, phaseHint]);

  // 静态历史消息 - 使用 Static 确保一旦渲染后不再更新
  // 包含 InfoPanel 作为第一个静态项，确保它永远不会重复渲染
  const staticItems = useMemo(() => {
    const headerItem = {
      id: "__info_panel__",
      node: <InfoPanel {...infoPanelProps} />,
    };

    const messageItems = items.map((row) => ({
      id: row.id,
      node:
          row.role === "user" ? (
            <MessageCard key={row.id} role="user">
              <UserTranscriptLines text={row.text} />
            </MessageCard>
          ) : (
            <Box key={row.id} flexDirection="column" width="100%" gap={0}>
              {row.assistantBlocks && row.assistantBlocks.length > 0 ? (
                (() => {
                  type AbPiece = {
                    key: string;
                    kind: SegmentKind;
                    node: React.ReactNode;
                  };
                  const abPieces: AbPiece[] = [];
                  row.assistantBlocks!.forEach((b, i) => {
                    if (b.kind === "text") {
                      if (!hasStreamText(b.text)) return;
                      abPieces.push({
                        key: `${row.id}-ab-${i}`,
                        kind: "model",
                        node: (
                          <StreamSegmentLine
                            text={b.text}
                            showCursor={false}
                          />
                        ),
                      });
                    } else if (hasRenderableAgentSteps(b.steps)) {
                      abPieces.push({
                        key: `${row.id}-ab-${i}`,
                        kind: "tools",
                        node: <AssistantStepsBlock steps={b.steps} />,
                      });
                    }
                  });
                  return abPieces.map((p, i) => (
                    <AssistantSegmentCard
                      key={p.key}
                      index={i}
                      kind={p.kind}
                      prevKind={i === 0 ? null : abPieces[i - 1]!.kind}
                    >
                      {p.node}
                    </AssistantSegmentCard>
                  ));
                })()
              ) : useInterleavedAssistantLayout(row) ? (
                (() => {
                  const segs = row.assistantBodySegments ?? [];
                  type Piece = {
                    key: string;
                    kind: SegmentKind;
                    node: React.ReactNode;
                  };
                  const pieces: Piece[] = [];
                  if (hasStreamText(segs[0])) {
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
                    if (!hasStreamText(seg)) return;
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
          ),
      }));

    return [headerItem, ...messageItems];
  }, [items, infoPanelProps]);

  return (
    <>
      {/* 静态区域：InfoPanel + 历史消息 - 一旦渲染就不再更新 */}
      <Static items={staticItems}>
        {(item) => (
          <Box key={item.id} flexDirection="column" width="100%">
            {item.node}
          </Box>
        )}
      </Static>

      {/* 动态区域：流式内容、错误、权限确认、输入框 */}
      <Box
        flexDirection="column"
        paddingX={1}
        gap={0}
        rowGap={0}
        columnGap={0}
        width="100%"
      >
        {streamingContent}

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

        {pendingPermission ? (
          <PermissionPrompt
            request={pendingPermission}
            onResolve={(choice: PermissionChoice) => {
              const allowed = choice !== "deny";
              if (choice === "allow" && pendingPermission) {
                addAllowedTool(pendingPermission.toolName);
              }
              permissionResolveRef.current?.(allowed);
              permissionResolveRef.current = null;
              setPendingPermission(null);
            }}
          />
        ) : null}

        {/* 输入框：确认框显示时完全卸载 */}
        {mode === "repl" && !busy && !pendingPermission ? (
          <ReplInputFooter onSubmitLine={stableOnSubmitLine} />
        ) : null}
      </Box>
    </>
  );
}
