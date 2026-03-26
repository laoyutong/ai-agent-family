# chatbot-memory 中的 MCP Client 工作流程

本文说明本应用在服务端如何使用 **@modelcontextprotocol/sdk** 的 `Client` 连接 MCP Server、如何与 **DeepSeek（OpenAI 兼容）** 对话结合，以及请求如何流经各模块。

---

## 1. 架构总览

```
.env（MCP_SERVERS）
       │
       ▼
┌──────────────────┐     stdio / HTTP      ┌─────────────────┐
│  createMcpPool   │ ◄──────────────────► │  MCP Server(s)  │
│  (mcp.ts)        │   SDK Client          │  (子进程或远程)  │
└────────┬─────────┘                       └─────────────────┘
         │ McpPool: listTools / callTool
         ▼
┌──────────────────┐     可选 HTTP 调试     浏览器 / curl
│  createApiApp    │ ◄──────────────────► GET/POST /api/mcp/*
│  (app.ts)        │
└────────┬─────────┘
         │ createMemoryChatbot({ mcp })
         ▼
┌──────────────────┐   messages（无 tools）  ┌──────────────────┐
│  chatbot.ts      │ ────────────────────► │ DeepSeek API      │
│  streamChat      │   mcp-facade-prompt   │ /v1/chat/...     │
│                  │   mcp-plan-execute    │                  │
│                  │   mcp-code-sandbox    │                  │
└──────────────────┘   chat-mcp-tools.ts └──────────────────┘
```

- **MCP Client**：Node 进程内的 `Client` 实例（每个已连接的服务器一个），负责协议层的 `listTools`、`callTool`。
- **McpPool**：对多个 `Client` 的薄封装，用配置里的 `id` 区分「连到哪台 MCP」，供聊天与 HTTP 共用。
- **大模型**：不直接连 MCP；通过 **在 system 中注入 `mcp` 门面说明**，让模型输出 **fenced 代码块**；服务端在 **`node:vm` 沙盒** 中执行代码，将 `mcp.xxx` / `__call_mcp__` 转发为 **`McpPool.callTool`**。
- **执行**：模型生成的代码在沙盒内运行；每次「工具调用」由拦截层映射到真实 MCP，**不再**使用 DeepSeek 的 `tools` / `tool_calls`。

---

## 2. 配置与启动：`mcp.ts`

### 2.1 读取 `MCP_SERVERS`

- 环境变量 `MCP_SERVERS` 为 **JSON 数组**；未设置或为空则 `configured === false`，等价于未启用 MCP。
- 支持 **`${VAR}`** 占位，在解析时替换为 `process.env.VAR`（便于根目录、密钥等不写死在 JSON 里）。
- 每条配置必须包含：
  - `id`：本应用内唯一，用于 `callTool(serverId, …)` 与聚合 `listTools` 时的 `serverId`。
  - `transport`：
    - **`stdio`**：`command`、`args?`、`env?`、`cwd?` —— 启动子进程，通过标准输入输出走 MCP。
    - **`http`**：`url` —— 使用 `StreamableHTTPClientTransport` 连接远程 MCP。

### 2.2 建立连接

对每个配置项：

1. `new Client({ name: "chatbot-memory", version: "0.0.0" })`
2. `client.connect(transport)`  
   - stdio：`StdioClientTransport`  
   - http：`StreamableHTTPClientTransport(new URL(url))`
3. 成功则加入内部 `entries: { id, client }[]`；失败则记录 `errors`，该 `id` 不可用。

### 2.3 `McpPool` 对外能力

| 方法 | 作用 |
|------|------|
| `configured` | 是否曾配置过 `MCP_SERVERS`（即使部分连接失败也可能为 true） |
| `getStatus()` | 每个配置 id 的传输方式、是否连上、错误信息、`getInstructions()` 等 |
| `listTools()` | 遍历所有**已成功连接**的 client，分页调用 `client.listTools`，合并为 `{ serverId, name, description, inputSchema }[]`（`serverId` 即配置里的 `id`） |
| `callTool(serverId, name, arguments)` | 根据 `serverId` 找到对应 `client`，调用 `client.callTool({ name, arguments })` |
| `close()` | 关闭所有 client（进程退出或 dev 热重载前释放子进程/HTTP 会话） |

日志统一带 `[MCP]` 前缀，便于排查。

---

## 3. HTTP 层：`app.ts`

应用启动时：

1. `createMcpPool()`（失败则 `createDisabledMcpPool()`）。
2. `createMemoryChatbot({ mcp })`，把同一 `McpPool` 注入聊天逻辑。

**与 MCP 相关的 REST 路由（便于调试，聊天主路径不依赖它们）：**

| 路由 | 说明 |
|------|------|
| `GET /api/mcp/status` | `configured` + `getStatus()` |
| `GET /api/mcp/tools` | `listTools()` 的原始合并列表 |
| `POST /api/mcp/call` | body: `{ serverId, name, arguments }`，直接 `callTool` |

**聊天：** `POST /api/chat` 只调用 `bot.stream(message, sessionId)`；是否在内部走 MCP，由 `chatbot.ts` 判断。

进程退出时 `shutdown()` 会执行 `mcp.close()`。

---

## 4. 与对话结合：`chatbot.ts` + `chat-mcp-tools.ts`

### 4.1 何时走 MCP 工具链路

在 `streamChat`（`chatbot.ts`）中，顺序如下（与「先组好 messages 再 listTools」的旧描述不同，已优化首字前等待）：

1. **熵过滤与工具列表并行**：若开启熵过滤且本轮仍可能走 MCP，则 **`Promise.all`** 同时执行 `filterDialogueByEntropyPrinciple` 与 **`mcpPool.listTools()`**（后者在不需要 MCP 时可跳过，见下）。二者都完成后，再组装 `messages`（system + 过滤后的 turns + 当前 user）。
2. **是否拉工具 / 是否走 MCP**（由环境变量与启发式共同决定）：
   - **`CHAT_MCP_ROUTER_HEURISTIC`**（默认 `true`）：先对**原始用户输入**调用 **`inferMcpRouteByHeuristic`**。若判定为明显寒暄，可 **跳过** `listTools` 与后续 MCP，直接 DeepSeek 流式；若判定为明显需要工具/文件等，则 **跳过** 路由 LLM，直接进入 MCP 链路（仍需先 `listTools`，已与熵过滤并行完成）。
   - **`CHAT_MCP_TURN_ROUTER`**（默认 `true`）：在启发式为「不明确」时，用非流式 **`shouldUseMcpSandboxForTurn`**（路由 LLM）判断本轮是否必须走沙盒；为 `false` 时只要 `listTools` 非空即走 MCP（旧行为）。路由 LLM 使用的是 **熵过滤之后** 的当前用户正文，与发给主对话的 `messages` 一致。
3. 若 `mcpPool?.configured` 为真、`listed.length > 0` 且判定应走 MCP，则进入 **`streamChatWithMcpTools(…)`**，而不是直接纯流式 `fetch(…, stream: true)`。
4. 若 `listTools` 失败或 MCP 路径抛错，会打日志并 **回退** 到无工具的流式对话。
5. 若未配置 MCP 或工具列表为空，行为与原来一致：仅 DeepSeek 流式补全。

会话记忆里仍只存 **user / assistant 文本**；代码执行与「【代码执行结果】」等中间消息只在**当轮**与模型的多轮往返中存在，**不**逐条写入 `turns`。

### 4.2 `streamChatWithMcpTools` 在做什么

1. **体积控制**：按环境变量限制工具数量、单工具 schema、工具返回长度、整段 `messages` JSON 等，避免 413（见 `loadChatMcpPayloadLimits`，定义于 `chat-mcp-limits.ts`）；必要时**裁减** `listTools()` 子集并缩小生成的 `mcp` 门面文本。
2. **门面生成**（`mcp-facade-prompt.ts`）：把 `listTools()` 的 `inputSchema` 转成简化的 TypeScript 式参数类型，生成 `declare function __call_mcp__(…)` 与 `export const mcp = { … }` 说明文本；维护 Map：**工具键 → (serverId, MCP toolName)**，与沙盒内注入的 `mcp` 方法一致。
3. **System 提示**：在首条 system 上追加【MCP 代码执行】说明与门面全文（若尚未包含【MCP 代码执行】标记）。
4. **多步 Plan-Execute 编排（可选，默认开启）**（`mcp-plan-execute.ts` + `runMcpSandboxCodegenLoop`）：
   - **启用条件**：`CHAT_MCP_PLAN_EXECUTE=true`（默认）且当前合并后的工具条数 ≥ `CHAT_MCP_PLAN_MIN_TOOLS`（默认 `2`）。仅连上 **1 台 MCP 且工具少** 时通常会跳过规划，直接走单段代码路径，避免多一次规划调用。
   - **Plan（规划）**：单独一次非流式 `chat/completions`（`temperature` 上限约 `0.35`，`max_tokens` 约 `2048`），system 为规划提示；user 含**当前用户问题**、**工具摘要**与**近期对话摘录**（便于消解「那个文件」等指代）。模型只应输出 **一个 `json` fenced 块**，形如 `{ "steps": [ { "id", "goal", "notes?" }, … ] }`。由 `parseMcpPlanFromModelText` 解析；失败则**整轮回退**为下面的单段路径。
   - **Execute（分步执行）**：对每一步从干净的「对话 + MCP system」副本追加一条 user：当前步骤目标、可选备注，以及 **`【此前步骤观测】`**（前面各步 `formatExecutionResultForLlm` 的合并摘要）。随后进入与单段相同的 **代码生成 ↔ 沙盒** 子循环，子循环重试上限为 `CHAT_MCP_PLAN_STEP_CODE_ROUNDS`（默认 `6`）。任一步在子循环内仍失败则**整轮抛错**（外层 `chatbot.ts` 可回退普通流式）。
   - **计划长度**：`CHAT_MCP_PLAN_MAX_STEPS`（默认 `8`）截断过长 `steps`，并打 `[MCP]` 日志。
   - **合并进终答**：多步全部成功后，**不**把中间多对 assistant/user（代码与执行细节）塞进写回 `turns` 的历史；而是用 `options.messages` 的干净副本 + 一条占位 assistant + 一条 user（合并后的 `【代码执行结果】` + 输出要求后缀），再走流式终答。调试时 `CHAT_MCP_ECHO_CODE_IN_CHAT=true` 可按**步** yield 已执行代码块。
5. **单段代码路径（回退或与规划互斥）**：与原先一致——在单条 user 任务下多轮非流式请求直至拿到可执行代码且沙盒 `ok: true`，或耗尽 **`MAX_MCP_CODE_ROUNDS`**（代码内常量，默认 `16`）。子逻辑由 **`runMcpSandboxCodegenLoop`** 统一实现，与分步共用沙盒与重试语义。
6. **代码生成轮**（非流式 `chat/completions`，**不传** `tools`）：
   - 模型输出须含 **一个** `javascript` / `typescript` fenced 代码块；解析后交给 `mcp-code-sandbox.ts`。
   - 若未找到代码块或沙盒执行未成功（且未超过**当前路径**下的轮次上限），在同一段 `messages` 中追加 **assistant + user（执行结果 + 重试说明）**，再请求模型**仅**输出修正后的代码块。
   - 若沙盒执行成功（`ok: true`），单段路径进入最终答复轮；多步路径则进入下一步或合并终答。
7. **沙盒执行**（`mcp-code-sandbox.ts`）：`node:vm` 受限上下文，仅暴露 `mcp`、`__call_mcp__`、受限 `console` 与安全内置对象；`Promise.race` 控制**总执行时长**（`CHAT_MCP_CODE_MAX_MS`）；**每一次 vm 运行**内 MCP 调用次数上限见 `CHAT_MCP_CODE_MAX_CALLS`（多步时**每一步**单独进沙盒，计数**每步重置**）。
8. **最终答复轮**：流式 `chat/completions`；单段路径下会先 **`prepareMessagesForFinalReply`**，把「含代码的 assistant」换成占位说明，避免终答复述代码。将增量正文 **yield** 给前端。

**分工**：**规划**与**每步代码**均由 **模型** 产出；是否在沙盒里执行、步骤间如何拼「观测」字符串、如何转发 MCP —— **本服务**。

---

## 5. 数据流小结（聊天主路径）

```
用户输入
  → （可选）熵过滤 ∥ listTools() 并行
  → 组装 messages（记忆 + 熵过滤结果）
  → （可选）MCP 启发式 / 路由 LLM 决定是否走沙盒
  → 若走 MCP：生成 mcp 门面文本 + system 说明（非 tools API）
  → （可选）非流式：先产出 json 步骤计划 → 按步重复：非流式 fenced 代码 → vm 沙盒 → callTool；步间附带「此前观测」
  → 或未规划：单段任务下非流式 fenced 代码 → vm 沙盒 → callTool
  → 必要时多轮「无代码 / 执行失败 → 重试仅输出代码块」（单段/分步各自有上限）
  → 流式：模型根据【代码执行结果】产出最终 assistant 正文
  → 写入 session.turns，摘要/裁切逻辑照旧
```

---

## 6. 相关文件

| 文件 | 职责 |
|------|------|
| `src/server/mcp.ts` | MCP 配置解析、Client 连接、`McpPool` |
| `src/server/app.ts` | 挂载 MCP HTTP 调试接口、注入 `mcp` 到 `createMemoryChatbot` |
| `src/server/chatbot.ts` | 判断是否走 `streamChatWithMcpTools` |
| `src/server/chat-mcp-limits.ts` | `CHAT_MCP_*` 体积与 `CHAT_MCP_CODE_*` 沙盒限额 |
| `src/server/mcp-facade-prompt.ts` | JSON Schema → TS 占位、`mcp` 门面字符串、工具键映射 |
| `src/server/mcp-code-sandbox.ts` | vm 沙盒、`mcp`/`__call_mcp__` → `callTool` |
| `src/server/chat-mcp-tools.ts` | Plan-Execute / 单段路径、`runMcpSandboxCodegenLoop`、最终流式；`inferMcpRouteByHeuristic`、路由 LLM |
| `src/server/mcp-plan-execute.ts` | MCP 多步规划提示词、工具/对话摘要、`parseMcpPlanFromModelText` |
| 仓库根 `.env.example` | `MCP_SERVERS`、`MCP_FILESYSTEM_ROOT`、`CHAT_MCP_*`、`CHAT_MCP_CODE_*`、`CHAT_MCP_PLAN_*`、`CHAT_MCP_TURN_ROUTER`、`CHAT_MCP_ROUTER_HEURISTIC` 等说明 |

### 6.1 与 Plan-Execute 相关的环境变量（摘录）

| 变量 | 默认 | 说明 |
|------|------|------|
| `CHAT_MCP_PLAN_EXECUTE` | `true` | 是否先 json 规划再多步执行；`false` 时恒走单段代码路径 |
| `CHAT_MCP_PLAN_MIN_TOOLS` | `2` | 工具数（`listTools` 合并条数）≥此值才做规划 |
| `CHAT_MCP_PLAN_MAX_STEPS` | `8` | 规划中 `steps` 最大保留条数 |
| `CHAT_MCP_PLAN_STEP_CODE_ROUNDS` | `6` | **每一步**内代码生成/沙盒失败时的最大重试轮数 |

其余 `CHAT_MCP_*` / `CHAT_MCP_CODE_*` 仍见 `chat-mcp-limits.ts` 与仓库根 `.env.example`。

---

## 7. 依赖版本说明

- MCP 协议交互依赖 **`@modelcontextprotocol/sdk`** 中的 `Client`、`StdioClientTransport`、`StreamableHTTPClientTransport`。
- 大模型侧：MCP 路径使用 **`messages` + 非流式/流式** `chat/completions`；**不再**对 MCP 使用 `tools` / `tool_choice`。
- 沙盒使用 Node 内置 **`node:vm`**（非进程级强隔离，生产环境若需更强隔离可再评估子进程或 `isolated-vm` 等方案）。

（文档随当前代码结构编写；若你改动路由或环境变量名，请同步更新本节与 `.env.example`。）
