import "./load-env.js";
import { ChatOpenAI } from "@langchain/openai";
import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { RunnableWithMessageHistory } from "@langchain/core/runnables";

const histories = new Map<string, InMemoryChatMessageHistory>();

export function createMemoryChatbot(options?: {
  model?: string;
  temperature?: number;
  systemPrompt?: string;
  baseURL?: string;
  apiKey?: string;
}) {
  const apiKey = options?.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const baseURL = options?.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const model = new ChatOpenAI({
    model: options?.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    temperature: options?.temperature ?? 0.7,
    apiKey,
    configuration: { baseURL },
    streaming: true,
  });

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      options?.systemPrompt ??
        "你的名字是「知忆」，一位沉稳、专业的中文对话伙伴。根据完整对话历史作答，主动记住用户提到的偏好、事实与约定，并在后续回复中自然运用。语气简洁有礼，避免机械套话。",
    ],
    new MessagesPlaceholder("chat_history"),
    ["human", "{input}"],
  ]);

  const chain = prompt.pipe(model);

  const withHistory = new RunnableWithMessageHistory({
    runnable: chain,
    getMessageHistory: async (sessionId) => {
      let history = histories.get(sessionId);
      if (!history) {
        history = new InMemoryChatMessageHistory();
        histories.set(sessionId, history);
      }
      return history;
    },
    inputMessagesKey: "input",
    historyMessagesKey: "chat_history",
  });

  return {
    /** 流式输出（token / 片段），用于 SSE */
    stream: (input: string, sessionId: string) =>
      withHistory.stream({ input }, { configurable: { sessionId } }),
    clearSession: (sessionId: string) => {
      histories.delete(sessionId);
    },
    clearAllSessions: () => {
      histories.clear();
    },
  };
}

export type MemoryChatbot = ReturnType<typeof createMemoryChatbot>;
