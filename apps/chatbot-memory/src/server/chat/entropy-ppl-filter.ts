/**
 * 基于困惑度（Perplexity）与信息熵思想的模型侧上下文过滤：
 * 用语言模型近似「低困惑度 = 给定上文后极易预测 = 冗余」的片段并剔除，保留高信息量内容。
 * 非真实逐 token 计算 PPL（需 logits），而是单次结构化重写。
 */

export type TurnForFilter = { role: "user" | "assistant"; content: string };

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

const FILTER_SYSTEM = [
  "你是「信息熵—困惑度」上下文过滤器，只做压缩与删冗，不改变事实与立场。",
  "",
  "定义（用于你的取舍，不要向用户复述）：",
  "- 语言模型的困惑度 Perplexity 与条件熵相关：在给定上文下，若某段话极易被预测，则其「条件困惑度」低，信息增量小，可视为冗余。",
  "- 客套、重复确认、与上文逐字重复的段落、空洞铺垫，通常属于低信息增量，应删除或极短化。",
  "- 用户约束、专名、数字、代码、公式、明确结论与否定、以及助手已给出的关键答案，属于高信息增量，必须保留（可略去环绕它的废话）。",
  "",
  "输出要求：",
  "- **仅**输出一个 JSON 对象，不要 markdown 代码围栏或其它文字。",
  '- 键 `turns`：数组，元素为 `{"role":"user"|"assistant","content":"..."}`，按时间顺序覆盖输入中的历史轮次（user 与 assistant 交替，与输入一致）。',
  '- 键 `current_user`：字符串，对应当前用户这条输入；若本身已很短或信息密集，可原文保留。',
  "- 总长度应明显短于输入，但若某轮已无冗余可删，可接近原文。",
  "- 不要编造对话中不存在的事实；不要合并不同轮次里的矛盾表述（应保留冲突双方原意中最短可辨表述）。",
].join("\n");

/** 从模型输出中解析出顶层 JSON 对象（支持 ``` 围栏），否则抛错 */
function parseStrictJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/m);
  const jsonStr = (fenced ? fenced[1] : trimmed).trim();
  const parsed = JSON.parse(jsonStr) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("filter output not object");
  }
  return parsed as Record<string, unknown>;
}

/** 将未知 JSON 数组安全转为 `TurnForFilter[]`，跳过非法元素 */
function coerceFilteredTurns(raw: unknown): TurnForFilter[] {
  if (!Array.isArray(raw)) return [];
  const out: TurnForFilter[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const role = o.role;
    const content = o.content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    out.push({ role, content });
  }
  return out;
}

/**
 * 用一次非流式调用按「困惑度/信息熵」提示词压缩历史与当前用户输入；
 * 返回过滤后的 `turns` 与 `currentUser`；解析失败则回退为原文。
 */
export async function filterDialogueByEntropyPrinciple(
  turns: readonly TurnForFilter[],
  currentUser: string,
  complete: (
    messages: ChatMessage[],
    req?: { model?: string; maxTokens?: number },
  ) => Promise<string>,
  req?: { model?: string; maxTokens?: number },
): Promise<{ turns: TurnForFilter[]; currentUser: string }> {
  const payload = JSON.stringify(
    {
      history_turns: turns,
      current_user: currentUser,
    },
    null,
    0,
  );

  const raw = await complete(
    [
      { role: "system", content: FILTER_SYSTEM },
      {
        role: "user",
        content: `请根据困惑度/信息熵原则过滤下列 JSON（字段 history_turns、current_user），并只输出过滤后的 JSON（turns、current_user）：\n${payload}`,
      },
    ],
    req,
  );

  try {
    const obj = parseStrictJsonObject(raw);
    const filteredTurns = coerceFilteredTurns(obj.turns);
    const cu =
      typeof obj.current_user === "string" && obj.current_user.trim()
        ? obj.current_user.trim()
        : currentUser.trim();

    if (turns.length > 0 && filteredTurns.length === 0) {
      throw new Error("empty turns");
    }

    return {
      turns: filteredTurns.length > 0 ? filteredTurns : [...turns],
      currentUser: cu || currentUser,
    };
  } catch {
    return { turns: [...turns], currentUser: currentUser.trim() || currentUser };
  }
}
