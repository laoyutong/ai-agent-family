import React, {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import type { ChatMessage } from "../services/llm/types.js";
import { runWithTools } from "../engine/run-with-tools.js";
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

const Transcript = memo(function Transcript({
  items,
}: {
  items: TranscriptItem[];
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {items.map((row) =>
        row.role === "user" ? (
          <MessageCard key={row.id} role="user">
            <Text wrap="wrap">{row.text}</Text>
          </MessageCard>
        ) : (
          <MessageCard key={row.id} role="assistant">
            <Text wrap="wrap">{row.text}</Text>
          </MessageCard>
        ),
      )}
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
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
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
          onStatus: (hint) => {
            setPhaseHint(hint);
          },
          onStreamReset: () => {
            setStreamText("");
          },
          onStreamDelta: (chunk) => {
            setStreamText((prev) => prev + chunk);
          },
        });
        setItems((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", text: assistantText },
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
