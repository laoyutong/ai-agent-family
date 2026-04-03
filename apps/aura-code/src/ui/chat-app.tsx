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

/** 收紧模型输出里的多余空行与行尾空白，减轻终端里段落间距过大的观感 */
function tightenTranscriptText(text: string): string {
  return text
    .replace(/(?:\r?\n[ \t]*){2,}/g, "\n")
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
    <Box flexDirection="column" gap={0} width="100%">
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
  /** 该条助手回复对应的模型/工具步骤（追加记录，不覆盖） */
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

/** 助手消息内工具步骤：与正文同一 MessageCard，无独立边框 */
const AssistantStepsBlock = memo(function AssistantStepsBlock(props: {
  steps: AgentStep[];
}): React.JSX.Element {
  return (
    <Box flexDirection="column" gap={0} marginBottom={0} width="100%">
      <AgentStepList steps={props.steps} compact />
    </Box>
  );
});

const MessageCard = memo(function MessageCard(props: {
  role: "user" | "assistant";
  children: React.ReactNode;
}): React.JSX.Element {
  const isUser = props.role === "user";
  const accent = isUser ? theme.user : theme.assistant;
  /** 用户 ● / 助手 ◆：形状不同，不只靠颜色 */
  const glyph = isUser ? "●" : "◆";
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

const AgentStepList = memo(function AgentStepList({
  steps,
  compact = false,
}: {
  steps: AgentStep[];
  compact?: boolean;
}): React.JSX.Element {
  let toolIdx = 0;
  return (
    <Box flexDirection="column" gap={0} marginBottom={compact ? 0 : 1} width="100%">
      {steps.map((step, i) => {
        if (step.tone === "round") {
          return null;
        }

        toolIdx += 1;
        const { glyph, color } = stepToneStyle(step.tone);
        const n = `${toolIdx}.`;
        const indexColW = n.length + 1;
        const stepNestPad = indexColW + 2;
        const outcomeErr =
          step.outcome &&
          (/^执行结果：错误：/.test(step.outcome) ||
            step.outcome.trimStart().startsWith("错误："));
        const rowKey = `${step.toolCallId ?? "s"}-${i}`;
        return (
          <Box key={rowKey} flexDirection="column" marginTop={0}>
            <Box flexDirection="row" alignItems="flex-start">
              <Box flexShrink={0}>
                <Text dimColor>{n} </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="wrap" color={color}>
                  {glyph}
                  {step.title}
                </Text>
              </Box>
            </Box>
            {step.detail ? (
              <Box paddingLeft={stepNestPad}>
                <Text dimColor wrap="wrap">
                  {step.detail}
                </Text>
              </Box>
            ) : null}
            {step.outcome ? (
              <Box paddingLeft={stepNestPad}>
                {outcomeErr ? (
                  <Text color={theme.error} wrap="wrap">
                    {step.outcome}
                  </Text>
                ) : (
                  <Text wrap="wrap" color={theme.assistant}>
                    {step.outcome}
                  </Text>
                )}
              </Box>
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
  /** 当前轮模型正在流式输出的正文（完成后会清空并入 transcript） */
  const [streamText, setStreamText] = useState("");
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
      setStreamText("");
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
          onStreamReset: () => {
            setStreamText("");
          },
          onStreamDelta: (chunk) => {
            setStreamText((prev) => prev + chunk);
          },
        });
        const persistedSteps = stepLogRef.current.filter(
          (s) =>
            s.tone === "fail" ||
            (s.tone === "invoke" &&
              (s.outcome !== undefined || s.invokeComplete)),
        );
        setItems((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: assistantText,
            steps:
              persistedSteps.length > 0 ? persistedSteps : undefined,
          },
        ]);
        // 轮次耗尽等：assistant 气泡已与 error 全文一致，不再叠一条红色框避免重复
        if (error && error.trim() !== assistantText.trim()) {
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
        setStreamText("");
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
    <Box flexDirection="column" paddingX={1} gap={0} width="100%">
      <Static items={staticFeed}>
        {(row) =>
          row.kind === "intro" ? (
            <MemoInfoPanel key="__info__" model={options.model} cwd={cwd} />
          ) : row.role === "user" ? (
            <MessageCard key={row.id} role="user">
              <UserTranscriptLines text={row.text} />
            </MessageCard>
          ) : (
            <MessageCard key={row.id} role="assistant">
              <Box flexDirection="column" gap={0} width="100%">
                {row.steps &&
                row.steps.length > 0 &&
                hasRenderableAgentSteps(row.steps) ? (
                  <AssistantStepsBlock steps={row.steps} />
                ) : null}
                <Box flexDirection="column" gap={0}>
                  <Text wrap="wrap" color={theme.assistant}>
                    {tightenTranscriptText(row.text)}
                  </Text>
                </Box>
              </Box>
            </MessageCard>
          )
        }
      </Static>

      {busy ? (
        <MessageCard role="assistant">
          <Box flexDirection="column" gap={0} width="100%">
            {stepLog.length > 0 && hasRenderableAgentSteps(stepLog) ? (
              <AssistantStepsBlock steps={stepLog} />
            ) : null}
            {streamText.length > 0 ? (
              <Box flexDirection="column" gap={0} width="100%">
                {/*
                  勿在 <Text wrap> 内嵌套带样式的子 <Text>：Ink squash/wrap 与 log-update
                  擦行在流式结束、转入 Static 时易错位。
                */}
                <Box flexDirection="row" alignItems="flex-start" width="100%">
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="wrap" color={theme.assistant}>
                      {tightenTranscriptText(streamText)}
                    </Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Text color={theme.hint}>▍</Text>
                  </Box>
                </Box>
              </Box>
            ) : (
              <Box flexDirection="row" flexWrap="wrap" alignItems="center">
                <Text color={theme.assistant}>
                  <Spinner type="dots" />
                </Text>
                <Text color={theme.hint} wrap="wrap">
                  {" "}
                  {phaseHint || "处理中…"}
                </Text>
              </Box>
            )}
          </Box>
        </MessageCard>
      ) : null}

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
