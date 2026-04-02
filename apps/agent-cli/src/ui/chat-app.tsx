import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { fetchStreaming } from "../services/llm/client.js";
import type { ChatMessage } from "../services/llm/types.js";
import {
  DEFAULT_SYSTEM,
  isAbortError,
  type ReplOptions,
} from "./session-options.js";
import { InfoPanel } from "./info-panel.js";
import { theme } from "./theme.js";

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

function MessageCard(props: {
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
}

export function ChatApp({
  mode,
  options,
  singlePrompt = "",
}: ChatAppProps): React.JSX.Element {
  const { exit } = useApp();
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const messagesRef = useRef<ChatMessage[]>([
    { role: "system", content: options.systemPrompt ?? DEFAULT_SYSTEM },
  ]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(mode === "single");
  const [streamText, setStreamText] = useState("");
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
      messagesRef.current.push({ role: "user", content: userText });
      setItems((prev) => [
        ...prev,
        { id: nextId(), role: "user", text: userText },
      ]);
      setBusy(true);
      setStreamText("");
      const ac = new AbortController();
      abortRef.current = ac;
      let assistant = "";

      try {
        for await (const chunk of fetchStreaming({
          chatUrl: options.chatUrl,
          apiKey: options.apiKey,
          model: options.model,
          messages: messagesRef.current,
          signal: ac.signal,
        })) {
          if (chunk.type === "text") {
            assistant += chunk.text;
            setStreamText(assistant);
          } else if (chunk.type === "error") {
            setErrorBanner(chunk.message);
            messagesRef.current.pop();
            setItems((prev) => prev.slice(0, -1));
            return;
          }
        }
        messagesRef.current.push({
          role: "assistant",
          content: assistant || null,
        });
        setItems((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", text: assistant },
        ]);
      } catch (e) {
        if (isAbortError(e)) {
          if (assistant.length > 0) {
            messagesRef.current.push({
              role: "assistant",
              content: assistant,
            });
            setItems((prev) => [
              ...prev,
              { id: nextId(), role: "assistant", text: assistant },
            ]);
          } else {
            messagesRef.current.pop();
            setItems((prev) => prev.slice(0, -1));
          }
        } else {
          setErrorBanner(e instanceof Error ? e.message : String(e));
          messagesRef.current.pop();
          setItems((prev) => prev.slice(0, -1));
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        setStreamText("");
      }
    },
    [options.apiKey, options.chatUrl, options.model],
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

  const onSubmit = (value: string): void => {
    if (busy || mode === "single") return;
    const t = value.trim();
    if (!t) return;
    if (t === "exit" || t === "quit") {
      exit();
      return;
    }
    setDraft("");
    void runGeneration(t);
  };

  const cwd = options.cwd ?? process.cwd();

  return (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <InfoPanel model={options.model} cwd={cwd} />

      <Static items={items} style={{ marginBottom: 0 }}>
        {(row) =>
          row.role === "user" ? (
            <MessageCard key={row.id} role="user">
              <Text wrap="wrap">{row.text}</Text>
            </MessageCard>
          ) : (
            <MessageCard key={row.id} role="assistant">
              <Text wrap="wrap">{row.text}</Text>
            </MessageCard>
          )
        }
      </Static>

      {busy && streamText.length === 0 ? (
        <Box
          paddingX={1}
          paddingY={0}
          marginBottom={0}
          borderStyle="round"
          borderColor={theme.border}
          borderDimColor
        >
          <Text color={theme.assistant}>
            <Spinner type="dots" />
          </Text>
          <Text color={theme.hint}> 正在连接模型…</Text>
        </Box>
      ) : null}

      {busy && streamText.length > 0 ? (
        <MessageCard role="assistant">
          <Text wrap="wrap">
            {streamText}
            <Text color={theme.brand} bold>
              ▌
            </Text>
          </Text>
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
        <Box flexDirection="column" marginTop={0}>
          <Text dimColor>
            {"─".repeat(
              Math.max(16, Math.min(64, (process.stdout.columns ?? 48) - 4)),
            )}
          </Text>
          <Box
            flexDirection="row"
            alignItems="center"
            paddingX={1}
            borderStyle="round"
            borderColor={theme.borderFocus}
          >
            <Text bold color={theme.prompt}>
              ›{" "}
            </Text>
            <TextInput
              value={draft}
              placeholder="有问题尽管问…"
              focus={!busy}
              onChange={setDraft}
              onSubmit={onSubmit}
            />
          </Box>
          <Box marginTop={0} paddingX={1}>
            <Text dimColor>
              Enter 发送
            </Text>
            <Text dimColor> · </Text>
            <Text dimColor>
              Ctrl+C 中断或退出
            </Text>
            <Text dimColor> · </Text>
            <Text dimColor>
              exit
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
