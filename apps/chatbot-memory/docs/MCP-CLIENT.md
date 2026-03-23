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
┌──────────────────┐     tools + messages   ┌──────────────────┐
│  chatbot.ts      │ ────────────────────► │ DeepSeek API      │
│  streamChat      │     chat-mcp-tools.ts  │ /v1/chat/...     │
└──────────────────┘                        └──────────────────┘
```

- **MCP Client**：Node 进程内的 `Client` 实例（每个已连接的服务器一个），负责协议层的 `listTools`、`callTool`。
- **McpPool**：对多个 `Client` 的薄封装，用配置里的 `id` 区分「连到哪台 MCP」，供聊天与 HTTP 共用。
- **大模型**：不直接连 MCP；通过 **Function Calling**（`tools` + `tool_choice: "auto"`）决定**是否**调工具、**调哪一个**；`listTools()` 只是把工具**定义**发给模型，**不会**自动执行每一个工具。
- **执行**：仅当某次模型响应里出现 `tool_calls` 时，本应用才 `McpPool.callTool`。

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

在 `streamChat` 中，组好本轮要发给模型的 `messages`（system + 历史 turns + 当前 user，并可能经过熵过滤）之后：

1. 若 `mcpPool?.configured` 为真，则 `await mcpPool.listTools()`。
2. 若 `listed.length > 0`，则 **不再** 直接走纯流式 `fetch(…, stream: true)`，而是进入 `streamChatWithMcpTools(…)`。
3. 若 MCP 路径抛错，会打日志并 **回退** 到无工具的流式对话。
4. 若未配置 MCP 或工具列表为空，行为与原来一致：仅 DeepSeek 流式补全。

会话记忆里仍只存 **user / assistant 文本**；工具调用与 `role: tool` 消息只在**当轮**与模型的多轮往返中存在，**不**逐条写入 `turns`。

### 4.2 `streamChatWithMcpTools` 在做什么

1. **体积控制**：按环境变量限制工具数量、单工具 schema、工具返回长度、整段 `messages` JSON 等，避免 413（见 `loadChatMcpPayloadLimits`）；必要时**裁减**发往模型的工具列表子集。
2. **工具映射到 OpenAI 形态**：把 `listTools()` 得到的能力描述转为请求里的 `tools[]`；`function.name` 可读、唯一且 **≤64 字符**；维护 Map：`name → (serverId, MCP toolName)`，用于解析模型返回的 `tool_calls`。
3. **System 提示**：在首条 system 上追加简短【工具】说明（若尚未包含）。
4. **多轮「模型 ↔ 工具结果」**（最多 `MAX_TOOL_ROUNDS`，**不是**对 MCP 上每个 tool 跑一遍）：
   - 调用 DeepSeek **`/v1/chat/completions`**，**非流式**，携带 `tools` 与 **`tool_choice: "auto"`**。
   - 若响应含 **`tool_calls`**：只对其中列出的函数执行 `mcp.callTool(...)`，将结果以 `role: "tool"` 追加到 `messages`，**再发下一轮**请求。
   - 若**无** `tool_calls` 且有最终 **`content`**：将助手正文分块 **yield**（经 SSE 到前端）。
5. **执行工具**：一律经 **`McpPool.callTool`**（SDK `Client.callTool`）。

**分工**：选哪个 tool、填什么参数 —— **模型**；是否执行、执行结果写回 —— **本服务**。

---

## 5. 数据流小结（聊天主路径）

```
用户输入
  → chatbot 组 messages（含记忆、熵过滤）
  → listTools() 拉取 MCP 工具定义（可能因体积限制只带部分工具）
  → 转为 DeepSeek tools[] + 压缩/截断
  → 循环（至多 MAX_TOOL_ROUNDS）：chat completions (tool_choice=auto)
        → 仅当响应含 tool_calls 时对其中条目 callTool，并追加 tool 结果
        → 直到某次无 tool_calls，得到最终 assistant 正文
  → 写入 session.turns，摘要/裁切逻辑照旧
```

---

## 6. 相关文件

| 文件 | 职责 |
|------|------|
| `src/server/mcp.ts` | MCP 配置解析、Client 连接、`McpPool` |
| `src/server/app.ts` | 挂载 MCP HTTP 调试接口、注入 `mcp` 到 `createMemoryChatbot` |
| `src/server/chatbot.ts` | 判断是否走 `streamChatWithMcpTools` |
| `src/server/chat-mcp-tools.ts` | DeepSeek tools 循环、体积控制、调用 `mcp.callTool` |
| 仓库根 `.env.example` | `MCP_SERVERS`、`MCP_FILESYSTEM_ROOT`、`CHAT_MCP_*` 等说明 |

---

## 7. 依赖版本说明

- MCP 协议交互依赖 **`@modelcontextprotocol/sdk`** 中的 `Client`、`StdioClientTransport`、`StreamableHTTPClientTransport`。
- 大模型侧使用与 **OpenAI Chat Completions** 兼容的字段：`messages`、`tools`、`tool_choice`。

（文档随当前代码结构编写；若你改动路由或环境变量名，请同步更新本节与 `.env.example`。）
