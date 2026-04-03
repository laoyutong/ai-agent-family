import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
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
import { theme } from "./theme.js";

const MemoInfoPanel = memo(InfoPanel);

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

/** 助手消息里「工具 / 轮次」区块：与正文分区，避免 Ink 换行时视觉上糊在一起 */
const AssistantStepsBlock = memo(function AssistantStepsBlock(props: {
  steps: AgentStep[];
  heading: string;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      paddingLeft={1}
      paddingY={0}
      borderLeft
      borderStyle="single"
      borderDimColor
      borderLeftColor={theme.hint}
    >
      <AgentStepList steps={props.steps} heading={props.heading} compact />
    </Box>
  );
});

const MessageCard = memo(function MessageCard(props: {
  role: "user" | "assistant";
  children: React.ReactNode;
}): React.JSX.Element {
  const isUser = props.role === "user";
  const accent = isUser ? theme.user : theme.assistant;
  const tag = isUser ? " YOU " : " AI ";
  const label = isUser ? "你" : "助手";
  return (
    <Box
      flexDirection="column"
      marginBottom={0}
      paddingLeft={1}
      paddingY={0}
      borderLeft
      borderStyle="single"
      borderLeftColor={accent}
    >
      <Box marginBottom={0}>
        <Text backgroundColor={accent} color="black" bold>
          {tag}
        </Text>
        <Text> </Text>
        <Text bold color={accent}>
          {label}
        </Text>
      </Box>
      <Box flexDirection="column" paddingTop={0} width="100%">
        {props.children}
      </Box>
    </Box>
  );
});

function stepToneStyle(tone: AgentStep["tone"]) {
  switch (tone) {
    case "invoke":
      return { glyph: "▸ ", color: theme.user };
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
  heading,
  compact = false,
}: {
  steps: AgentStep[];
  heading: string;
  /** 为 true 时不留列表底部外边距（外层分区 Box 已负责与正文的间距） */
  compact?: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={compact ? 0 : 1} width="100%">
      <Box marginBottom={1}>
        <Text bold color={theme.hint}>
          {heading}
        </Text>
      </Box>
      {steps.map((step, i) => {
        const { glyph, color } = stepToneStyle(step.tone);
        const n = `${i + 1}.`;
        return (
          <Box key={i} flexDirection="column" marginTop={0}>
            <Box flexDirection="row" alignItems="flex-start">
              <Box flexShrink={0}>
                <Text dimColor>{n} </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text
                  wrap="wrap"
                  color={color}
                  bold={step.tone === "round"}
                >
                  {glyph}
                  {step.title}
                </Text>
              </Box>
            </Box>
            {step.detail ? (
              <Box paddingLeft={n.length + 1}>
                <Text dimColor wrap="wrap">
                  {step.detail}
                </Text>
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
  /** 本轮从「请求模型 / 工具调用」到结束的步骤记录，追加写入、不覆盖 */
  const [stepLog, setStepLog] = useState<AgentStep[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stepLogRef = useRef<AgentStep[]>([]);
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
              stepLogRef.current.push(step);
              setStepLog([...stepLogRef.current]);
            }
          },
          onStreamReset: () => {
            setStreamText("");
          },
          onStreamDelta: (chunk) => {
            setStreamText((prev) => prev + chunk);
          },
        });
        const steps = [...stepLogRef.current];
        setItems((prev) => [
          ...prev,
          {
            id: nextId(),
            role: "assistant",
            text: assistantText,
            steps: steps.length > 0 ? steps : undefined,
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
              <Text wrap="wrap">{row.text}</Text>
            </MessageCard>
          ) : (
            <MessageCard key={row.id} role="assistant">
              <Box flexDirection="column" width="100%">
                {row.steps && row.steps.length > 0 ? (
                  <AssistantStepsBlock
                    steps={row.steps}
                    heading="执行步骤"
                  />
                ) : null}
                <Box flexDirection="column">
                  {row.steps && row.steps.length > 0 ? (
                    <Text dimColor bold>
                      回复
                    </Text>
                  ) : null}
                  <Text wrap="wrap">{row.text}</Text>
                </Box>
              </Box>
            </MessageCard>
          )
        }
      </Static>

      {busy ? (
        <MessageCard role="assistant">
          <Box flexDirection="column" width="100%">
            {stepLog.length > 0 ? (
              <AssistantStepsBlock steps={stepLog} heading="进行中" />
            ) : null}
            {streamText.length > 0 ? (
              <Box flexDirection="column" width="100%">
                {stepLog.length > 0 ? (
                  <Text dimColor bold>
                    生成中
                  </Text>
                ) : null}
                {/*
                  勿在 <Text wrap> 内嵌套带样式的子 <Text>：Ink squash/wrap 与 log-update
                  擦行在流式结束、转入 Static 时易错位。
                */}
                <Box flexDirection="row" alignItems="flex-start" width="100%">
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="wrap">{streamText}</Text>
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
            {errorBanner}
          </Text>
        </Box>
      ) : null}

      {mode === "repl" && !busy ? (
        <ReplInputFooter onSubmitLine={stableOnSubmitLine} />
      ) : null}
    </Box>
  );
}
