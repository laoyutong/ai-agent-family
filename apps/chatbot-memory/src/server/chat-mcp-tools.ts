import { squeezeMessagesForByteBudget, trimMessagesForByteBudget } from "./chat-message-budget.js";
import { parseEnvBool, parseIntEnv } from "./chat-env.js";
import { loadChatMcpPayloadLimits, loadMcpCodeSandboxLimits, type ChatMcpPayloadLimits } from "./chat-mcp-limits.js";
import { fetchChatCompletionNonStream, joinUrl } from "./deepseek-client.js";
import { parseSseDataLine } from "./deepseek-sse.js";
import { logMcpSandboxCode, runMcpSandboxCode } from "./mcp-code-sandbox.js";
import { buildMcpFacadeFromTools, extractFirstFencedCodeBlock } from "./mcp-facade-prompt.js";
import type { McpPool } from "./mcp.js";
import {
  buildPlannerUserContent,
  parseMcpPlanFromModelText,
  plannerSystemPrompt,
  type McpPlan,
} from "./mcp-plan-execute.js";
import { readUtf8Lines } from "../shared/stream-read.js";
import { truncateForLog } from "./log-preview.js";

export type { ChatMcpPayloadLimits };

/** 沙盒执行结果写控制台日志时的最大字符数（发给模型的仍为全文） */
const SANDBOX_EXEC_LOG_MAX_CHARS = 12_000;

type ChatMessageForMcp =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null };

/**
 * 单轮用户消息内，「生成代码 → 沙盒执行 → 模型最终答复」的最大尝试次数（含重试生成代码）。
 */
const MAX_MCP_CODE_ROUNDS = 16;

/** 多步编排：单步内「生成代码 → 执行 → 重试」上限 */
const MAX_MCP_PLAN_STEP_CODE_ROUNDS = () => parseIntEnv("CHAT_MCP_PLAN_STEP_CODE_ROUNDS", 6);

/** 多步编排：计划中最台阶数上限 */
const MAX_MCP_PLAN_STEPS = () => parseIntEnv("CHAT_MCP_PLAN_MAX_STEPS", 8);

const MCP_SANDBOX_ROUTER_SYSTEM = `你是路由助手。根据「用户消息」与「可用 MCP 工具」判断：本轮是否必须调用至少一个工具（读文件、列目录、搜索、外部 API 等）才能正确回答。
- 若仅需常识、闲聊、逻辑推理、或仅用已有对话上下文即可回答，回复 NO。
- 若需要访问工作区文件、运行工具、查询外部数据等，回复 YES。
只输出一行：YES 或 NO，不要其他文字。`;

function buildMcpRouterToolsHint(
  listed: Awaited<ReturnType<McpPool["listTools"]>>,
  limits: ChatMcpPayloadLimits,
): string {
  const slice = listed.slice(0, limits.maxTools);
  return slice
    .map((t) => {
      const desc = (t.description ?? "").trim();
      return `- ${t.serverId}/${t.name}${desc ? `: ${desc}` : ""}`;
    })
    .join("\n");
}

/**
 * 在调用 LLM 路由前做快速预判，减少一次非流式补全。
 * - `true`：明显需要工具/文件/搜索等，直接走 MCP 路径（不调路由模型）。
 * - `false`：极短、明显纯寒暄，可跳过 MCP 与 listTools（不调路由模型）。
 * - `null`：不确定，需调用 `shouldUseMcpSandboxForTurn`。
 *
 * 设计偏保守：`false` 仅用于短句寒暄，避免长句误判；`true` 覆盖常见工具意图。
 */
export function inferMcpRouteByHeuristic(userMessage: string): boolean | null {
  const s = userMessage.trim();
  if (s.length === 0) return null;

  if (
    /\b(mcp|glob|grep|workspace|filesystem|proto[\-_]?nexus)\b/i.test(s) ||
    /读(取|一下)?文件|打开文件|列出(目录|文件)|列目录|查找.*(文件|目录)|搜索.*(文件|目录|代码|项目)|文件(路径|列表|内容|树)|工作区|目录下|文件夹里|\.(ts|tsx|js|jsx|json|md|py|yaml|yml)\b/.test(
      s,
    ) ||
    /\b(read|list|search|find|open|glob)\s+(file|folder|directory|path|the\s)/i.test(s) ||
    /listFiles|readFile|globFile|文件列表|搜(一下|索)|查(一下|看).*代码|仓库里|项目里.*(文件|代码)/i.test(s)
  ) {
    return true;
  }

  if (s.length <= 24) {
    if (
      /^(你好|在吗|您好|哈喽|嗨|hi|hello|谢谢|多谢|感谢|再见|拜拜|好的|嗯|ok|OK|是的|不是|可以|不行|明白了|收到|知道了|没问题|辛苦了|早上好|晚上好|午安)[\s。!！?？~～]*$/i.test(
        s,
      )
    ) {
      return false;
    }
  }

  return null;
}

/**
 * 本轮是否应走「生成代码 → 沙盒」链路。为省 token 使用短非流式补全；解析失败时默认 true（宁可多走 MCP）。
 */
export async function shouldUseMcpSandboxForTurn(options: {
  chatUrl: string;
  apiKey: string;
  model: string;
  /** 本轮用户正文（与发给主对话的一致） */
  userMessage: string;
  listed: Awaited<ReturnType<McpPool["listTools"]>>;
  limits: ChatMcpPayloadLimits;
}): Promise<boolean> {
  const toolsHint = buildMcpRouterToolsHint(options.listed, options.limits);
  const { content } = await fetchChatCompletionNonStream({
    chatUrl: options.chatUrl,
    apiKey: options.apiKey,
    model: options.model,
    temperature: 0,
    maxTokens: 8,
    messages: [
      { role: "system", content: MCP_SANDBOX_ROUTER_SYSTEM },
      {
        role: "user",
        content: `【可用工具】\n${toolsHint}\n\n【用户消息】\n${options.userMessage}`,
      },
    ],
  });
  const text = (content ?? "").trim().toUpperCase();
  if (/\bNO\b/.test(text) && !/\bYES\b/.test(text)) return false;
  return true;
}

function formatExecutionResultForLlm(
  sandbox: Awaited<ReturnType<typeof runMcpSandboxCode>>,
  noCodeFallback: string | null,
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
  return parts.join("\n");
}

const MCP_CODE_SYSTEM_HINT = `
【MCP 代码执行】当用户问题需要外部能力时，请根据下方 **mcp** API 说明编写可在服务端沙盒中运行的逻辑代码。
- 运行时由服务端注入真实的 \`mcp\` 与 \`__call_mcp__\`；禁止使用 require、import、process、fs、fetch 及任何网络/文件访问。
- 请在本回复中输出**恰好一个** fenced 代码块，语言标记为 \`javascript\` 或 \`typescript\`。
- **调用 MCP 工具时必须写 \`await __call_mcp__(toolKey, args)\`**：\`toolKey\` 只能从门面里每一行 \`=> __call_mcp__("……", args)\` 中**第一个字符串参数原样复制**（含连字符 \`-\`、大小写一致）。**禁止**使用 \`await mcp.xxx(args)\` 点号形式：易把 \`-\` 误写成 \`_\`，运行会报 \`is not a function\`。
- 若用括号访问，可写 \`await mcp["与门面完全相同的键字符串"](args)\`，键须逐字复制，**禁止**把 \`-\` 改成 \`_\`。
- 可写 \`async function main() { ... }\` 并在末尾 \`return await main();\`。
- 若使用 filesystem 类 MCP：路径须为**服务器工作区根目录**下的相对路径（例如 \`code\`、\`code/foo.txt\`），不要使用本机绝对路径或臆造根目录。
`.trim();

const FINAL_REPLY_USER_SUFFIX = `
【输出要求】请用自然、简洁的中文直接回答用户问题；不要输出 markdown 代码块；不要复述或展示已执行的代码；若工具报错，用一两句话说明原因与可行操作（如检查路径是否在 MCP 工作区内），不要整段粘贴原始 JSON。`;

type SandboxCodegenContext = {
  chatUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  mcp: McpPool;
  nameToRef: Map<string, { serverId: string; toolName: string }>;
  limits: ChatMcpPayloadLimits;
  sandboxLimits: ReturnType<typeof loadMcpCodeSandboxLimits>;
  echoRoundTag: string;
};

/**
 * 在已组好的 messages 上循环：非流式要代码 → 沙盒执行，成功则尾部为 assistant(含代码)+user(执行结果)。
 */
async function runMcpSandboxCodegenLoop(
  messages: ChatMessageForMcp[],
  maxRounds: number,
  ctx: SandboxCodegenContext,
): Promise<{ ok: true; lastSandboxCode: string; execText: string } | { ok: false }> {
  let lastAssistant = "";
  let lastSandboxCode: string | null = null;
  let round = 0;
  for (; round < maxRounds; round++) {
    squeezeMessagesForByteBudget(messages, ctx.limits.maxContextJsonBytes);
    const { content } = await fetchChatCompletionNonStream({
      chatUrl: ctx.chatUrl,
      apiKey: ctx.apiKey,
      model: ctx.model,
      temperature: ctx.temperature,
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
        mcp: ctx.mcp,
        nameToRef: ctx.nameToRef,
        maxMs: ctx.sandboxLimits.maxMs,
        maxCalls: ctx.sandboxLimits.maxCalls,
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

    const execText = formatExecutionResultForLlm(execPayload, noCodeNote);
    if (execPayload.ok) {
      console.log(
        `[MCP] sandbox:exec ${ctx.echoRoundTag} round=${round} ok=true calls=${execPayload.callCount}`,
      );
    } else {
      const execLogText = truncateForLog(execText, SANDBOX_EXEC_LOG_MAX_CHARS);
      console.log(
        `[MCP] sandbox:exec ${ctx.echoRoundTag} round=${round} ok=false calls=${execPayload.callCount}\n${execLogText}`,
      );
    }
    messages.push({ role: "assistant", content: lastAssistant });

    if (code && execPayload.ok && lastSandboxCode) {
      messages.push({ role: "user", content: execText });
      return { ok: true, lastSandboxCode, execText };
    }

    const retryHint = !code
      ? "请**仅**输出一个 `javascript` 或 `typescript` 的 fenced 代码块，完成上述任务；不要省略代码块。"
      : "上一段代码执行未成功。请根据【代码执行结果】修正逻辑后，**仅**输出一个修正后的 fenced 代码块。";
    messages.push({ role: "user", content: `${execText}\n\n${retryHint}` });
  }
  console.warn(`[MCP] ${ctx.echoRoundTag} sandbox 未在 ${maxRounds} 轮内成功`);
  return { ok: false };
}

async function fetchMcpExecutionPlan(options: {
  chatUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  userMessage: string;
  listed: Awaited<ReturnType<McpPool["listTools"]>>;
  limits: ChatMcpPayloadLimits;
  dialogue: Array<{ role: string; content: string }>;
}): Promise<McpPlan | null> {
  const userContent = buildPlannerUserContent({
    userMessage: options.userMessage,
    listed: options.listed,
    limits: options.limits,
    dialogue: options.dialogue,
  });
  const planTemp = Math.min(options.temperature, 0.35);
  const { content } = await fetchChatCompletionNonStream({
    chatUrl: options.chatUrl,
    apiKey: options.apiKey,
    model: options.model,
    temperature: planTemp,
    maxTokens: 2048,
    messages: [
      { role: "system", content: plannerSystemPrompt() },
      { role: "user", content: userContent },
    ],
  });
  const text = typeof content === "string" ? content : "";
  const plan = parseMcpPlanFromModelText(text);
  if (plan) {
    const cap = MAX_MCP_PLAN_STEPS();
    if (plan.steps.length > cap) {
      console.warn(`[MCP] plan 步骤 ${plan.steps.length} 超出上限 ${cap}，已截断`);
      plan.steps = plan.steps.slice(0, cap);
    }
    console.log(`[MCP] plan 解析成功`, { steps: plan.steps.length, ids: plan.steps.map((s) => s.id) });
  } else {
    console.warn(`[MCP] plan 解析失败，回退单段代码路径`);
  }
  return plan;
}

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
  const planExecuteEnabled = parseEnvBool("CHAT_MCP_PLAN_EXECUTE", true);
  const planMinTools = parseIntEnv("CHAT_MCP_PLAN_MIN_TOOLS", 2);

  const codegenCtx: SandboxCodegenContext = {
    chatUrl,
    apiKey,
    model,
    temperature,
    mcp,
    nameToRef,
    limits,
    sandboxLimits,
    echoRoundTag: "codegen",
  };

  let lastSandboxCode: string | null = null;
  let lastSandboxCodes: string[] = [];
  let streamMessages!: ChatMessageForMcp[];

  const lastUserMsg = [...options.messages].reverse().find((m) => m.role === "user");
  const userMessageForPlan =
    lastUserMsg && typeof lastUserMsg.content === "string" ? lastUserMsg.content : "";
  const dialogueForPlan = options.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : "",
    }));

  let usedPlan = false;
  if (planExecuteEnabled && list.length >= planMinTools && userMessageForPlan) {
    const plan = await fetchMcpExecutionPlan({
      chatUrl,
      apiKey,
      model,
      temperature,
      userMessage: userMessageForPlan,
      listed: list,
      limits,
      dialogue: dialogueForPlan,
    });
    if (plan && plan.steps.length > 0) {
      usedPlan = true;
      const stepExecTexts: string[] = [];
      let priorAgg = "";

      for (let si = 0; si < plan.steps.length; si++) {
        const step = plan.steps[si];
        const stepLabel = `步骤 ${si + 1}/${plan.steps.length}（id=${step.id}）`;
        const stepPrompt = [
          `【MCP 多步编排】${stepLabel}`,
          `目标：${step.goal}`,
          step.notes ? `备注：${step.notes}` : "",
          priorAgg ? `【此前步骤观测】\n${priorAgg}` : `【此前步骤观测】（无）`,
          `请**仅**输出一个 \`javascript\` 或 \`typescript\` 的 fenced 代码块，完成**当前步骤**；须用 \`await __call_mcp__(门面里对应工具的字符串键, args)\`，勿用 \`mcp.xxx\` 点号；返回值与 console 会写入后续「观测」。`,
        ]
          .filter(Boolean)
          .join("\n\n");

        const stepMessages = messages.map((m) => ({ ...m }));
        squeezeMessagesForByteBudget(stepMessages, limits.maxContextJsonBytes);
        stepMessages.push({ role: "user", content: stepPrompt });

        const stepRounds = MAX_MCP_PLAN_STEP_CODE_ROUNDS();
        const stepResult = await runMcpSandboxCodegenLoop(stepMessages, stepRounds, {
          ...codegenCtx,
          echoRoundTag: `plan ${si + 1}/${plan.steps.length}`,
        });
        if (!stepResult.ok) {
          throw new Error(`MCP 多步编排：${stepLabel} 在 ${stepRounds} 轮内未成功执行`);
        }
        lastSandboxCodes.push(stepResult.lastSandboxCode);
        stepExecTexts.push(`### ${stepLabel}\n${stepResult.execText}`);
        priorAgg = stepExecTexts.join("\n\n");
      }

      lastSandboxCode = lastSandboxCodes[lastSandboxCodes.length - 1] ?? null;

      const mergedExec = `【代码执行结果】\n${stepExecTexts.join("\n\n---\n\n")}`;

      streamMessages = trimMessagesForByteBudget(
        options.messages.map((m) => ({ ...m })),
        limits.maxContextJsonBytes,
      );
      streamMessages.push({
        role: "assistant",
        content:
          "（前置步骤已完成：已按编排计划执行多步 MCP；代码不向用户展示。）请仅根据下一条 user 中的【代码执行结果】组织答复。",
      });
      streamMessages.push({
        role: "user",
        content: mergedExec + FINAL_REPLY_USER_SUFFIX,
      });
      squeezeMessagesForByteBudget(streamMessages, limits.maxContextJsonBytes);
    }
  }

  if (!usedPlan) {
    const singlePass = await runMcpSandboxCodegenLoop(messages, MAX_MCP_CODE_ROUNDS, codegenCtx);
    if (!singlePass.ok) {
      throw new Error(`MCP 代码生成与执行超过 ${MAX_MCP_CODE_ROUNDS} 轮上限`);
    }
    lastSandboxCode = singlePass.lastSandboxCode;
    prepareMessagesForFinalReply(messages);
    streamMessages = messages;
    squeezeMessagesForByteBudget(streamMessages, limits.maxContextJsonBytes);
  }

  const res = await fetch(chatUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: streamMessages,
      stream: true,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${errText}`);
  }

  let assistantFull = "";
  if (echoCodeToUser && lastSandboxCodes.length > 0) {
    const parts = lastSandboxCodes.map(
      (c, i) => `**[MCP 已执行代码 步 ${i + 1}]**\n\n\`\`\`javascript\n${c}\n\`\`\`\n`,
    );
    const codeBlock = `\n\n${parts.join("\n")}\n---\n\n`;
    assistantFull += codeBlock;
    yield codeBlock;
  } else if (echoCodeToUser && lastSandboxCode) {
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
