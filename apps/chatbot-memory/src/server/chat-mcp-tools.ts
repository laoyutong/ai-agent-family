import { squeezeMessagesForByteBudget, trimMessagesForByteBudget } from "./chat-message-budget.js";
import { parseEnvBool } from "./chat-env.js";
import { loadChatMcpPayloadLimits, loadMcpCodeSandboxLimits, type ChatMcpPayloadLimits } from "./chat-mcp-limits.js";
import { fetchChatCompletionNonStream, joinUrl } from "./deepseek-client.js";
import { parseSseDataLine } from "./deepseek-sse.js";
import { logMcpSandboxCode, runMcpSandboxCode } from "./mcp-code-sandbox.js";
import { buildMcpFacadeFromTools, extractFirstFencedCodeBlock } from "./mcp-facade-prompt.js";
import type { McpPool } from "./mcp.js";
import { clipText } from "../shared/text.js";
import { readUtf8Lines } from "../shared/stream-read.js";

export type { ChatMcpPayloadLimits };

type ChatMessageForMcp =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null };

/**
 * 单轮用户消息内，「生成代码 → 沙盒执行 → 模型最终答复」的最大尝试次数（含重试生成代码）。
 */
const MAX_MCP_CODE_ROUNDS = 16;

function formatExecutionResultForLlm(
  sandbox: Awaited<ReturnType<typeof runMcpSandboxCode>>,
  noCodeFallback: string | null,
  maxChars: number,
): string {
  const parts: string[] = ["【代码执行结果】"];
  if (noCodeFallback) {
    parts.push(noCodeFallback);
  }
  if (sandbox.consoleLines.length) {
    parts.push("--- console ---");
    parts.push(sandbox.consoleLines.join("\n"));
  }
  if (sandbox.ok) {
    parts.push("--- return ---");
    try {
      parts.push(JSON.stringify(sandbox.returnValue));
    } catch {
      parts.push(String(sandbox.returnValue));
    }
    parts.push(`(MCP 调用次数: ${sandbox.callCount})`);
  } else {
    parts.push("--- error ---");
    parts.push(sandbox.error ?? "unknown");
    parts.push(`(MCP 调用次数: ${sandbox.callCount})`);
  }
  return clipText(parts.join("\n"), maxChars);
}

const MCP_CODE_SYSTEM_HINT = `
【MCP 代码执行】当用户问题需要外部能力时，请根据下方 **mcp** API 说明编写可在服务端沙盒中运行的逻辑代码。
- 运行时由服务端注入真实的 \`mcp\` 与 \`__call_mcp__\`；禁止使用 require、import、process、fs、fetch 及任何网络/文件访问。
- 请在本回复中输出**恰好一个** fenced 代码块，语言标记为 \`javascript\` 或 \`typescript\`。
- 代码块内为异步逻辑，可使用 \`await mcp.xxx(...)\` 或 \`await __call_mcp__(toolKey, args)\`；可写 \`async function main() { ... }\` 并在末尾 \`return await main();\`。
- 不要编造不存在的工具键名；工具键名须与下方 \`mcp\` 对象中的键一致。
- 若使用 filesystem 类 MCP：路径须为**服务器工作区根目录**下的相对路径（例如 \`code\`、\`code/foo.txt\`），不要使用本机绝对路径或臆造根目录。
`.trim();

const FINAL_REPLY_USER_SUFFIX = `
【输出要求】请用自然、简洁的中文直接回答用户问题；不要输出 markdown 代码块；不要复述或展示已执行的代码；若工具报错，用一两句话说明原因与可行操作（如检查路径是否在 MCP 工作区内），不要整段粘贴原始 JSON。`;

/** 最终流式请求前：用占位替换「含代码的 assistant」，避免模型把代码复述给用户 */
function prepareMessagesForFinalReply(messages: ChatMessageForMcp[]): void {
  const last = messages[messages.length - 1];
  const secondLast = messages[messages.length - 2];
  if (
    last?.role === "user" &&
    typeof last.content === "string" &&
    last.content.startsWith("【代码执行结果】") &&
    secondLast?.role === "assistant"
  ) {
    messages[messages.length - 2] = {
      role: "assistant",
      content:
        "（前置步骤已完成：已在沙盒中执行 MCP 调用代码；原代码内容不向用户展示。）请仅根据下一条 user 中的【代码执行结果】组织答复。",
    };
    messages[messages.length - 1] = {
      role: "user",
      content: last.content + FINAL_REPLY_USER_SUFFIX,
    };
  }
}

/**
 * 使用「生成代码 → vm 沙盒执行（拦截 mcp）→ 将结果写回 → 流式最终答复」驱动 MCP。
 */
export async function* streamChatWithMcpTools(options: {
  mcp: McpPool;
  chatBaseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** 已含 system、历史 user/assistant、本轮 user */
  messages: ChatMessageForMcp[];
  /**
   * 若已由调用方执行过 `listTools()`，传入可避免重复请求 MCP（例如 chatbot 先拉列表判断非空）。
   */
  toolsList?: Awaited<ReturnType<McpPool["listTools"]>>;
}): AsyncGenerator<string, string> {
  const { mcp, chatBaseUrl, apiKey, model, temperature } = options;
  const limits = loadChatMcpPayloadLimits();
  const sandboxLimits = loadMcpCodeSandboxLimits();
  let messages: ChatMessageForMcp[] = options.messages.map((m) => ({ ...m }));
  messages = trimMessagesForByteBudget(messages, limits.maxContextJsonBytes);

  const list = options.toolsList ?? (await mcp.listTools());
  const { facadeText, nameToRef } = buildMcpFacadeFromTools(list, limits);
  if (nameToRef.size === 0) {
    throw new Error("MCP 未返回可用工具");
  }

  const apiBlock = `\n\n${MCP_CODE_SYSTEM_HINT}\n\n${facadeText}\n`;
  if (messages[0]?.role === "system" && typeof messages[0].content === "string") {
    if (!messages[0].content.includes("【MCP 代码执行】")) {
      messages[0] = { ...messages[0], content: messages[0].content + apiBlock };
    }
  } else {
    messages.unshift({ role: "system", content: MCP_CODE_SYSTEM_HINT + "\n\n" + facadeText });
  }

  const chatUrl = joinUrl(chatBaseUrl, "/v1/chat/completions");
  /** 默认不向用户展示沙盒代码；仅调试时可设 CHAT_MCP_ECHO_CODE_IN_CHAT=true */
  const echoCodeToUser = parseEnvBool("CHAT_MCP_ECHO_CODE_IN_CHAT", false);

  let lastAssistant = "";
  /** 沙盒执行成功时，最后一次运行的代码正文（用于日志与可选回显） */
  let lastSandboxCode: string | null = null;
  let round = 0;
  for (; round < MAX_MCP_CODE_ROUNDS; round++) {
    squeezeMessagesForByteBudget(messages, limits.maxContextJsonBytes);
    const { content } = await fetchChatCompletionNonStream({
      chatUrl,
      apiKey,
      model,
      temperature,
      messages,
    });
    lastAssistant = typeof content === "string" ? content : "";
    const code = extractFirstFencedCodeBlock(lastAssistant);
    let execPayload: Awaited<ReturnType<typeof runMcpSandboxCode>>;
    let noCodeNote: string | null = null;

    if (code) {
      logMcpSandboxCode(round, code);
      execPayload = await runMcpSandboxCode({
        code,
        mcp,
        nameToRef,
        maxMs: sandboxLimits.maxMs,
        maxCalls: sandboxLimits.maxCalls,
        maxToolResultChars: limits.maxToolResultChars,
      });
      if (execPayload.ok) {
        lastSandboxCode = code;
      }
    } else {
      noCodeNote =
        "未在模型输出中找到 fenced 代码块（javascript/typescript）。请勿在后续说明中复述模型全文或臆造代码。";
      execPayload = {
        ok: false,
        error: "未找到可执行代码块",
        consoleLines: [],
        callCount: 0,
      };
    }

    const execText = formatExecutionResultForLlm(execPayload, noCodeNote, limits.maxToolResultChars);
    messages.push({ role: "assistant", content: lastAssistant });

    if (code && execPayload.ok) {
      messages.push({ role: "user", content: execText });
      break;
    }

    const retryHint = !code
      ? "请**仅**输出一个 `javascript` 或 `typescript` 的 fenced 代码块，完成上述任务；不要省略代码块。"
      : "上一段代码执行未成功。请根据【代码执行结果】修正逻辑后，**仅**输出一个修正后的 fenced 代码块。";
    messages.push({ role: "user", content: `${execText}\n\n${retryHint}` });
  }

  if (round >= MAX_MCP_CODE_ROUNDS) {
    throw new Error(`MCP 代码生成与执行超过 ${MAX_MCP_CODE_ROUNDS} 轮上限`);
  }

  prepareMessagesForFinalReply(messages);

  squeezeMessagesForByteBudget(messages, limits.maxContextJsonBytes);

  const res = await fetch(chatUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      messages,
      stream: true,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${errText}`);
  }

  let assistantFull = "";
  if (echoCodeToUser && lastSandboxCode) {
    const codeBlock = `\n\n**[MCP 已执行代码]**\n\n\`\`\`javascript\n${lastSandboxCode}\n\`\`\`\n\n---\n\n`;
    assistantFull += codeBlock;
    yield codeBlock;
  }

  for await (const line of readUtf8Lines(res.body)) {
    const text = parseSseDataLine(line);
    if (text) {
      assistantFull += text;
      yield text;
    }
  }
  return assistantFull;
}
