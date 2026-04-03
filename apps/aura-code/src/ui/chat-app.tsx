import React, {
  memo,
  useCallback,
  useEffect,
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

export type ChatAppProps = {
  mode: "repl" | "single";
  options: ReplOptions;
  singlePrompt?: string;
};

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
      <Box paddingTop={0}>
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
  /** 为 true 时不留列表底部外边距（嵌入「进行中」面板时用） */
  compact?: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={compact ? 0 : 1}>
      <Text bold color={theme.hint}>
        {heading}
      </Text>
      {steps.map((step, i) => {
        const { glyph, color } = stepToneStyle(step.tone);
        const n = `${i + 1}.`;
        return (
          <Box key={i} flexDirection="column">
            <Text wrap="wrap">
              <Text dimColor>{n} </Text>
              <Text color={color} bold={step.tone === "round"}>
                {glyph}
                {step.title}
              </Text>
            </Text>
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

/** 已结束的轮次写入 Static，避免整段对话都算进 Ink 动态高度，触发清屏/全屏分支来回切换 */
const Transcript = memo(function Transcript({
  items,
}: {
  items: TranscriptItem[];
}): React.JSX.Element {
  return (
    <Static items={items}>
      {(row) =>
        row.role === "user" ? (
          <MessageCard key={row.id} role="user">
            <Text wrap="wrap">{row.text}</Text>
          </MessageCard>
        ) : (
          <MessageCard key={row.id} role="assistant">
            {row.steps && row.steps.length > 0 ? (
              <AgentStepList steps={row.steps} heading="步骤" />
            ) : null}
            <Text wrap="wrap">{row.text}</Text>
          </MessageCard>
        )
      }
    </Static>
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

  return (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <MemoInfoPanel model={options.model} cwd={cwd} />

      <Transcript items={items} />

      {busy && stepLog.length > 0 ? (
        <Box
          flexDirection="column"
          marginBottom={0}
          paddingLeft={1}
          borderStyle="single"
          borderColor={theme.border}
          borderDimColor
        >
          <AgentStepList steps={stepLog} heading="进行中" compact />
        </Box>
      ) : null}

      {busy && streamText.length > 0 ? (
        <MessageCard role="assistant">
          <Text wrap="wrap">
            {streamText}
            <Text color={theme.hint}>▍</Text>
          </Text>
        </MessageCard>
      ) : null}

      {busy && streamText.length === 0 ? (
        <Box
          paddingX={1}
          paddingY={0}
          marginBottom={0}
          borderStyle="round"
          borderColor={theme.border}
          borderDimColor
          flexDirection="row"
          flexWrap="wrap"
        >
          <Text color={theme.assistant}>
            <Spinner type="dots" />
          </Text>
          <Text color={theme.hint} wrap="wrap">
            {" "}
            {phaseHint || "处理中…"}
          </Text>
        </Box>
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
