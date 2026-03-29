# 知忆（chatbot-memory）项目规划与优化汇总

本文档描述 **当前实现**（第二节）与 **规划 / 风险 / 待优化**（第三节）。代码路径以 `apps/chatbot-memory/src/` 为准。

---

## 一、项目定位与运行形态

| 维度 | 说明 |
|------|------|
| 定位 | 浏览器端「知忆」：多会话、本地持久化、Markdown 渲染、可选 MCP 工具代码沙盒 |
| 技术栈 | TypeScript、**Vite 6**、**Express 4**、DeepSeek（OpenAI 兼容 HTTP）、`@modelcontextprotocol/sdk`（**无 LangChain**） |
| 开发 | `pnpm dev`：`tsx` 跑 `dev.ts`，Vite 与 **`/api` 同进程同端口**（默认 **5173**） |
| 生产 | `pnpm build` + `pnpm start`：先打静态资源再 `node dist/server/index.js`，默认端口 **3001**（均可 `PORT` 覆盖） |
| 记忆模型 | `turns`（近期逐轮）+ `summary` / `facts`（折叠后的中长期层）；可选 **折叠原文归档** 与 **注入 system** |
| MCP | 非原生 `tools` API：模型输出代码 → 子进程 **`node:vm`** → IPC → 父进程 **`callTool`**（可同进程回退调试） |

---

## 二、当前实现概要

### 2.1 会话记忆与 system 组装

- **`SessionMemory`**（`chat-types.ts`）：`turns`（仅 user/assistant，交替）、可选 `summary`、`facts`、可选 **`foldArchiveLinks`**（与磁盘归档批次一一对应）；**`foldChain`** 串行折叠任务。
- **`buildSystemContent`**（`system-content.ts`）：单条 system = 人设 + 可选【用户级长期要点】+【本会话长期要点】+【会话前期摘要】+ 可选【**原文归档节选**】（由 `buildFoldArchiveInjectBlock` 生成）。近期逐轮对话在 `messages` 的 user/assistant 中。

### 2.2 折叠、增量摘要与裁切

- **`memory-turns.ts`**：超长时裁切 `turns`、按配置每 N 对触发增量摘要批次（`popIncrementalSummaryBatch` 等）。
- **`memory-fold.ts`**：`foldDroppedIntoLayers` 将移出轮次合并进 `summary`/`facts`；经 **`enqueueFold`** 挂到 `session.foldChain`，避免并发写竞态。

### 2.3 折叠原文归档与注入（可选）

- 环境变量 **`CHAT_FOLD_ARCHIVE_*`**（见根目录 `README`）：默认在会话库父目录下 **`fold-archives/`** 按会话存批次；可关闭归档或关闭注入。
- **`FoldArchiveStore`**：折叠前写入被移出 `turns`；折叠成功后 **`finalizeEntry`** 与 `session.foldArchiveLinks` 同步。
- **`buildFoldArchiveInjectBlock`**：按 **`relevant`（lexical 打分）** 或 **`recent`** 选取批次拼入 system；与 `chatbot.ts` 中每轮用户输入联动。
- **HTTP**：`GET .../fold-archives`、`GET .../fold-archives/:index` 供查阅完整归档与摘要前后对照。

### 2.4 熵过滤（回合结束后异步）

- **`CHAT_CONTEXT_ENTROPY_PPL_*`**（`chat-env.ts`）：开关、最小字符门槛、非流式模型与 `max_tokens`。
- **`scheduleEntropyCompressAfterTurn`**（`chatbot.ts`）：本轮 user/assistant **已写入 `turns`** 后，异步调用 **`filterDialogueByEntropyPrinciple`**，改写已落盘历史，**供下一轮起**生效；**不阻塞**本轮首包。

### 2.5 单轮请求链路（主对话 + MCP）

- **首包前无同步熵 API**。顺序要点：准备 system / 历史 `turns` / 本轮原文 → **`inferMcpRouteByHeuristic`** → 若可能需要 MCP 则 **`await listTools()`**（**`MCP_LIST_TOOLS_CACHE_TTL_MS`** TTL 缓存 + 并发合并）→ 组装 **`messages`** → 可选 **`shouldUseMcpSandboxForTurn`**（路由 LLM，与本轮 user 原文一致）→ **`streamChatWithMcpTools`** 或直连 DeepSeek **SSE 流式**。
- **MCP 沙盒**：子进程内 **`node:vm`**（`mcp-sandbox-child.ts`）；默认 **`CHAT_MCP_SANDBOX_POOL_SIZE`**（默认 **4**）**复用 fork**，降低多步 Plan / 多轮 codegen 的进程创建开销；**`0`** 关闭池（每次执行新建子进程）。敏感环境变量在父进程侧剥离。
- **Plan-Execute**（`mcp-plan-execute.ts` + `chat-mcp-tools.ts`）：工具数 ≥ `CHAT_MCP_PLAN_MIN_TOOLS` 等条件满足时可 json 规划再分步执行；否则单段代码循环（轮次上限等见 `MCP-CLIENT.md`）。

### 2.6 持久化与用户级事实

- **`session-store.ts`**：默认 **`~/.chatbot-memory/sessions/`** 每会话一文件 + `manifest.json`；`CHAT_SESSION_STORE_PATH` 以 `.json` 结尾时旧版单文件模式；支持从 **`sessions.json`** 一次性迁移。
- **`user-facts-store.ts`**：默认 `~/.chatbot-memory/user-facts.json`；折叠后会话 `facts` 可合并入用户库；可选 **`CHAT_USER_FACTS_PROMOTE_LLM`**。

### 2.7 SSE 与 MCP 阶段提示（已实现）

- **`POST /api/chat`**：`text/event-stream`，`data:` 行为 JSON。
- **正文**：`{ "text": "…" }`；结束 `{ "done": true }`；错误 `{ "error": "…" }`。
- **阶段**（`shared/chat-stream.ts`）：MCP 路径上可下发 **`{ "phase": "…" }`**，取值含 **`mcp_planning`**、**`mcp_codegen`**、**`mcp_tools`**、**`mcp_summarizing`**；前端可用 **`phaseLabel()`** 展示短文案。此为**粗粒度阶段**，非 Plan 每一步的序号/目标字符串。

---

## 三、未实现与优化方向

### 3.1 体验与可观测性

- **MCP 细粒度进度**：已有 phase 四段；**未实现**每步 Plan 的序号/总数/目标文案、与代码子轮次的更细事件（若产品需要再扩展 `ChatStreamPart` 与 `app.ts` 写出字段）。
- **客户端断线取消**：SSE 断开后服务端仍可能跑满 `streamChat` / `fetch` / 沙盒；需 **`AbortController`** 与 **`req.on("close")`** 贯通。

### 3.2 会话持久化

- **`saveChain`** 串行 + 单轮多事件触发多次落盘 → 多会话并发时队列积压。**方向**：debounce、按 `dirtyIds` 批量写；长期可选 **SQLite**。

### 3.3 MCP 沙盒安全

- **子进程池**已实现（见 2.5）；仍可选部署层隔离、**`isolated-vm`** 等。**残余风险**：`vm` 非完整隔离。

### 3.4 记忆折叠失败路径

- `foldDroppedIntoLayers` 失败时仅日志，可能导致内容既不在 `turns` 也未进 `summary`/`facts`。**方向**：回灌、`pendingDropped`、有限重试。

### 3.5 前端与服务端 LLM 客户端

- 流式 Markdown 全量渲染：**方向**节流 / rAF、虚拟列表等。
- **fetch 无统一超时 / 重试**：**方向**在 `deepseek-client.ts` 等集中封装；**env** 每轮解析 **方向**模块级缓存。

### 3.6 功能与产品（规划中）

| 方向 | 说明 |
|------|------|
| 用户事实结构化 | key-value、冲突覆盖等（当前多为行文本） |
| 对话分支 | 线性 `turns` → 树；类型、存储、UI |
| 多模型路由 | 抽象 `LLMClient`、按任务路由 |
| 会话导出 / 搜索 / 标题 LLM | 导出 API、内存或 FTS 搜索、首轮后自动生成标题 |
| Agent Workflow Builder | 独立应用或 monorepo 扩展 |

---

## 四、优先级汇总（待办；随排期调整）

| 优先级 | 项目 | 类型 |
|--------|------|------|
| P0 | LLM 客户端统一封装 + 超时/重试 | 优化 |
| P0 | 折叠失败回灌 / 重试 / `pendingDropped` | 优化 |
| P0 | MCP **步骤级**进度（Plan 步序号/目标 + 可选前端步骤条）；粗粒度 `phase` 已有 | 体验 |
| P1 | 客户端断线 `AbortController` 取消下游 | 功能 |
| P1 | env 解析模块级缓存 | 优化 |
| P1 | 沙盒：部署级隔离 / `isolated-vm`（可选） | 安全 |
| P2 | `saveChain` debounce / 批量落盘 | 优化 |
| P2 | 会话标题 LLM、导出 API、会话搜索 | 功能 |
| P2 | 用户事实结构化 | 功能 |
| P2 | 前端流式节流 / 虚拟列表 | 优化 |
| P2 | 多模型路由 | 功能 |
| P2 | 持久化 SQLite（可选演进） | 优化 |
| P3 | 对话分支 | 功能 |
| P3 | Agent Workflow Builder | 功能 |

---

## 五、代码与文档索引

| 路径 | 说明 |
|------|------|
| `src/server/dev.ts` / `src/server/index.ts` | 开发 / 生产入口 |
| `src/server/http/app.ts` | Express、SSE、`/api/*`、MCP 调试路由 |
| `src/server/chat/chatbot.ts` | 主对话、异步熵压缩、MCP 分支、折叠入队、归档注入 |
| `src/server/chat/chat-types.ts` | `SessionMemory`、消息类型 |
| `src/server/chat/system-content.ts` | system 拼装 |
| `src/server/chat/memory-fold.ts` / `memory-turns.ts` | 折叠队列、裁切与增量批次 |
| `src/server/chat/fold-archive-inject.ts` | 归档节选生成与 lexical 选择 |
| `src/server/chat/entropy-ppl-filter.ts` | 熵过滤实现 |
| `src/server/config/chat-env.ts` | 记忆 / 熵 / 归档注入等环境配置 |
| `src/server/mcp/chat-mcp-tools.ts` | MCP 路由、Plan-Execute、沙盒循环、**phase** yield |
| `src/server/mcp/mcp-plan-execute.ts` | 多步规划解析 |
| `src/server/mcp/mcp-code-sandbox.ts` / `mcp-sandbox-child.ts` | 子进程池 + vm、`CHAT_MCP_SANDBOX_POOL_SIZE` |
| `src/server/mcp/mcp.ts` | `listTools` TTL、`callTool`、连接池 |
| `src/server/mcp/mcp-facade-prompt.ts` | 门面与工具映射 |
| `src/server/llm/deepseek-client.ts` / `deepseek-sse.ts` | 非流式封装、SSE 解析 |
| `src/server/persistence/session-store.ts` | 会话分文件与 manifest |
| `src/server/persistence/fold-archive-store.ts` | 折叠归档磁盘格式 |
| `src/server/persistence/user-facts-store.ts` | 用户级事实 |
| `src/server/chat/user-facts-promote.ts` | 折叠后写入用户库 / 可选 LLM 筛选 |
| `src/shared/chat-stream.ts` | SSE 片段类型、`phase` 枚举与 `phaseLabel` |
| `src/client/main.ts` | 浏览器 UI、SSE、Markdown |
| `docs/MCP-CLIENT.md` | MCP 与对话结合的详细说明 |

---

## 六、修订记录

| 日期 | 说明 |
|------|------|
| 2025-03-25 | 初版路线图（原 PROJECT-ANALYSIS-AND-ROADMAP） |
| 2025-03-26 | 同步：LLM 扇出、分文件持久化、用户级事实、MCP Plan-Execute、fork 沙箱 |
| 2026-03-29 | 合并服务端审查；已实现 / 未实现分章；`listTools` 缓存、熵异步顺序等与代码对齐 |
| 2026-03-29 | **按当前仓库重梳**：补充折叠归档、SSE `phase`、修正技术栈；细化「未实现」与优先级（MCP 进度区分粗/细粒度） |
| 2026-03-29 | MCP 沙盒 **子进程池**（`CHAT_MCP_SANDBOX_POOL_SIZE`，默认 4） |
