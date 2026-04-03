# aura-code 实现路线图

> 光环代码：受 [Claude Code 架构](https://github.com/laoyutong/claude-code) 启发，基于 DeepSeek API 构建的终端 AI 编程助手。
> 以下路线图按**阶段递进**组织，每个 Phase 可独立交付、可运行。

---

## 架构对照总览

下表列出 Claude Code 的核心子系统，以及本项目对应的模块与实现阶段。

| Claude Code 子系统 | 规模 | aura-code 对应模块 | Phase |
|---|---|---|---|
| `main.tsx` 入口 + Commander.js CLI | ~1 文件 | `src/main.ts` + `src/cli.ts` | 0 |
| `QueryEngine.ts` LLM 查询引擎 | ~46K 行 | `src/services/llm/` | 1 |
| React + Ink 终端 UI | ~140 组件 | `src/ui/` (readline → 后期可选 Ink) | 2 |
| `Tool.ts` + `src/tools/` 工具系统 | ~29K + ~40 工具 | `src/tools/` | 3 |
| QueryEngine tool-call loop | 核心循环 | `src/engine/query-engine.ts` | 4 |
| `hooks/toolPermission/` 权限系统 | ~多个 hooks | `src/engine/permissions.ts` | 5 |
| `src/commands/` 命令系统 | ~50 命令 | `src/commands/` | 6 |
| `context.ts` + `memdir/` 记忆 | 多文件 | `src/services/memory/` | 7 |
| `cost-tracker.ts` token 计费 | ~1 文件 | `src/services/cost-tracker.ts` | 8 |
| `services/mcp/` MCP 协议 | 连接池 + 工具发现 | `src/services/mcp/` | 9 |
| `coordinator/` + AgentTool 多代理 | 编排器 | `src/engine/agent.ts` + `src/coordinator/` | 10 |
| `plugins/` + `skills/` + `bridge/` | 插件/技能/IDE | `src/plugins/` `src/skills/` `src/bridge/` | 11 |

---

## Phase 0 — 项目骨架与启动流程

**目标**：建立可运行的 CLI 入口，从终端启动并加载 `.env` 配置。

### 模块清单

```
src/
├── main.ts              # 入口：dotenv → 参数解析 → 启动 REPL 或单次执行
├── cli.ts               # Commander.js 参数定义（--model, --cwd, --version 等）
├── config.ts            # 统一配置：环境变量 + CLI 参数 → 类型安全的 Config 对象
└── types/
    └── index.ts         # 共享类型（ChatMessage, Config 等）
```

### 关键设计

- **统一 Config**：`config.ts` 使用 Zod schema 合并 `.env` + CLI 参数，导出 `getConfig()` 单例。
- **快速启动**：参照 Claude Code 的 Parallel Prefetch 模式，在 `main.ts` 顶层以 side-effect 方式提前触发 env 加载和 API key 校验，不阻塞后续 import。

### 交付标准

- [x] `pnpm --filter aura-code dev` 可启动
- [ ] 无 API key 时输出友好错误提示并退出
- [ ] `--help` 打印用法说明
- [ ] `--version` 打印版本号

---

## Phase 1 — LLM 客户端层

**目标**：封装 DeepSeek OpenAI 兼容 API，提供流式与非流式两种调用方式。

### 模块清单

```
src/services/llm/
├── client.ts            # 核心 HTTP 客户端：fetchStreaming / fetchNonStreaming
├── sse-parser.ts        # SSE data 行解析（与 chatbot-memory 的 deepseek-sse.ts 对齐）
├── token-estimator.ts   # 基于字符数的粗略 token 估算（后期可接 tiktoken）
└── types.ts             # OpenAI 兼容的请求/响应类型
```

### 关键设计

| 决策点 | 方案 |
|---|---|
| 消息格式 | OpenAI Chat Completions 格式（`messages[]`、`tools[]`、`tool_choice`） |
| 流式 | `stream: true` + SSE 逐行解析，返回 `AsyncGenerator<LLMStreamChunk>` |
| 非流式 | `stream: false`，返回完整 `ChatCompletion` |
| Tool calling | 使用 DeepSeek 原生 `tools` + `tool_calls` 字段（非 Claude Code 的 fenced-code 模式） |
| 重试 | 指数退避，429 / 5xx 自动重试，最多 3 次 |
| 超时 | 流式首 chunk 30s，整体 5min，可配置 |

### 交付标准

- [ ] `fetchStreaming()` 可流式获取 DeepSeek 回复
- [ ] `fetchNonStreaming()` 可一次性获取完整回复
- [ ] 支持 `tools[]` 参数，解析 `tool_calls` 返回
- [ ] 错误码 429 / 5xx 自动重试

---

## Phase 2 — 交互式 REPL

**目标**：基础交互式终端，用户输入 → LLM 流式输出 → 循环。

### 模块清单

```
src/ui/
├── repl.tsx             # Ink render 入口（交互 / 单次模式）
├── chat-app.tsx         # React+Ink 主界面：Static 历史、流式区、TextInput
├── session-options.ts   # ReplOptions、system 预设、isAbortError
├── spinner.ts           # （可选）独立 spinner；当前用 ink-spinner
├── markdown-render.ts   # Markdown → 终端 ANSI（后续）
└── theme.ts             # 颜色主题（后续）
```

### 关键设计

- **Ink + React**：`<Static>` 累积对话历史，动态区展示流式回复与 `ink-text-input`；`maxFps`/`incrementalRendering` 减轻闪烁。
- **流式输出**：`fetchStreaming` 增量更新 React state，带动 Ink 重绘。
- **中断**：`Ctrl+C` —— 生成中 `AbortController.abort()`，空闲时 `exit()`；`render({ exitOnCtrlC: false })` 由应用接管。
- **多行输入**：后续可用 `\` 续行或 TextArea 风格扩展（当前单行 + Enter）。

### 交付标准

- [ ] 用户输入自然语言 → DeepSeek 流式回复 → 彩色输出
- [ ] `Ctrl+C` 可中断当前生成
- [ ] 输入历史（上下箭头）

---

## Phase 3 — 工具系统

**目标**：定义工具接口与注册表，实现 6 个核心工具。

### 3.1 工具接口（对标 Claude Code `Tool.ts`）

```
src/tools/
├── tool.ts              # Tool 接口定义 + ToolRegistry
├── bash.ts              # BashTool：shell 命令执行
├── file-read.ts         # FileReadTool：文件读取
├── file-write.ts        # FileWriteTool：文件创建/覆盖
├── file-edit.ts         # FileEditTool：字符串替换局部编辑
├── glob.ts              # GlobTool：文件名模式搜索
└── grep.ts              # GrepTool：ripgrep 内容搜索
```

### 3.2 Tool 接口设计

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodSchema;          // Zod schema → 自动生成 JSON Schema 给 LLM
  permission: PermissionLevel;     // 'safe' | 'cautious' | 'dangerous'
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolContext {
  cwd: string;                     // 当前工作目录
  abortSignal: AbortSignal;        // 取消信号
  onProgress?: (msg: string) => void;  // 进度回调（流式输出中间状态）
}

interface ToolResult {
  output: string;                  // 文本结果（回传给 LLM）
  error?: string;                  // 错误信息
  metadata?: Record<string, unknown>;
}
```

### 3.3 核心工具规格

| 工具 | 权限 | 输入参数 | 说明 |
|---|---|---|---|
| `BashTool` | dangerous | `command`, `timeout?` | `child_process.spawn`，捕获 stdout+stderr，超时可杀 |
| `FileReadTool` | safe | `path`, `offset?`, `limit?` | 读文件内容，支持行号范围；二进制文件返回元信息 |
| `FileWritTool` | cautious | `path`, `content` | 创建或覆盖文件；自动创建父目录 |
| `FileEditTool` | cautious | `path`, `old_string`, `new_string` | 精确字符串替换；`old_string` 须在文件中唯一匹配 |
| `GlobTool` | safe | `pattern`, `cwd?` | 基于 `glob` 包的文件名搜索 |
| `GrepTool` | safe | `pattern`, `path?`, `include?` | 调用 `rg`（ripgrep），解析输出 |

### 交付标准

- [ ] `ToolRegistry` 可注册/查询/列举工具
- [ ] 每个工具可独立单元测试
- [ ] `registry.toOpenAITools()` 输出 OpenAI `tools[]` 格式 JSON Schema

---

## Phase 4 — 查询引擎（核心循环）

**目标**：实现 LLM ↔ Tool 的循环调用，对标 Claude Code `QueryEngine.ts`。

### 模块清单

```
src/engine/
├── query-engine.ts      # 核心：流式循环 LLM → 检测 tool_calls → 执行 → 回传结果 → 继续
├── message-builder.ts   # 组装 system + context + turns + user message
└── context.ts           # 系统上下文收集（OS, shell, cwd, git branch 等）
```

### 4.1 循环流程

```
用户输入
    ↓
组装 messages（system + history + user）
    ↓
┌─→ LLM 流式调用（带 tools[]）
│       ↓
│   输出文本 chunks → 实时显示
│       ↓
│   检测 tool_calls?
│   ├── 无 → 回合结束，写入 history
│   └── 有 → 逐个执行工具
│           ↓
│       权限检查（Phase 5）
│           ↓
│       执行 tool → 获取 ToolResult
│           ↓
│       将 tool result 追加到 messages
│           ↓
└───────── 再次调用 LLM（携带 tool results）
```

### 4.2 关键设计

| 决策点 | 方案 |
|---|---|
| 最大循环次数 | 默认 25 轮（可配置 `MAX_TOOL_ROUNDS`），防无限循环 |
| 并行工具调用 | 若 LLM 返回多个 `tool_calls`，`Promise.all` 并行执行 |
| 工具结果格式 | 以 `role: "tool"` + `tool_call_id` 回传，符合 OpenAI 规范 |
| 流式中断 | 用户 `Ctrl+C` → AbortController 传播到 LLM 请求和工具执行 |
| 错误处理 | 工具执行失败 → 将错误信息作为 tool result 回传 LLM，让它自行修正 |

### 交付标准

- [ ] 用户提问 → LLM 判断需要工具 → 自动调用 → 汇总回答
- [ ] 多轮工具链正常工作（如：grep 找到文件 → read 文件 → edit 文件）
- [ ] 工具执行失败时 LLM 可自动重试或换策略

---

## Phase 5 — 权限系统

**目标**：在工具执行前进行权限检查，对标 Claude Code `hooks/toolPermission/`。

### 模块清单

```
src/engine/
└── permissions.ts       # 权限检查 + 用户审批交互
```

### 5.1 权限等级

| 等级 | 行为 | 典型工具 |
|---|---|---|
| `safe` | 自动放行，不提示 | FileRead, Glob, Grep |
| `cautious` | 显示摘要，要求 `y/n` 确认 | FileWrite, FileEdit |
| `dangerous` | 显示完整参数 + 警告色，要求确认 | Bash |

### 5.2 权限模式

| 模式 | 说明 |
|---|---|
| `default` | 按工具等级逐次审批 |
| `yolo` | 跳过所有审批（`--yolo` 启动参数） |
| `plan` | 只读模式，拒绝所有 cautious/dangerous 工具 |
| `allowlist` | `.aura-code/permissions.json` 白名单，匹配则自动放行 |

### 交付标准

- [ ] `cautious`/`dangerous` 工具执行前显示确认提示
- [ ] `--yolo` 模式跳过全部确认
- [ ] 用户选择"本次全部允许"后该工具后续自动放行

---

## Phase 6 — 命令系统

**目标**：支持 `/` 前缀的斜杠命令，对标 Claude Code `src/commands/`。

### 模块清单

```
src/commands/
├── registry.ts          # CommandRegistry：注册/匹配/执行
├── help.ts              # /help — 显示可用命令列表
├── clear.ts             # /clear — 清空当前会话
├── compact.ts           # /compact — 手动压缩上下文
├── cost.ts              # /cost — 显示本次会话 token 消耗与费用
├── diff.ts              # /diff — 显示本次会话修改的文件 diff
├── tools.ts             # /tools — 列出已注册工具
├── model.ts             # /model — 切换模型
└── config.ts            # /config — 显示/修改运行时配置
```

### 命令接口

```typescript
interface Command {
  name: string;            // 不含 '/' 前缀
  aliases?: string[];
  description: string;
  execute(args: string, ctx: CommandContext): Promise<void>;
}
```

### 交付标准

- [ ] REPL 中输入 `/help` 可看到命令列表
- [ ] `/clear` 重置会话
- [ ] `/cost` 显示累计 token 和估算费用
- [ ] 未知命令给出提示

---

## Phase 7 — 上下文与记忆

**目标**：会话持久化 + 上下文压缩，对标 Claude Code `context.ts` + `memdir/` + chatbot-memory 的记忆分层。

### 模块清单

```
src/services/memory/
├── session-store.ts     # 会话持久化（JSON 文件，~/.aura-code/sessions/）
├── context-builder.ts   # System prompt 组装：系统信息 + 项目上下文 + 记忆摘要
├── compactor.ts         # 上下文压缩：超过 token 上限时 LLM 摘要旧对话
└── project-context.ts   # 自动收集项目信息：README, package.json, git info, 目录结构
```

### 7.1 记忆分层（简化自 chatbot-memory）

```
                    ┌─────────────┐
                    │ System 注入  │  ← 项目上下文 + 摘要 + 用户偏好
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
    ┌────┴────┐     ┌──────┴──────┐    ┌─────┴─────┐
    │  turns  │     │   summary   │    │   facts   │
    │ 逐轮原文 │     │  叙事摘要   │    │ 结构化要点 │
    └────┬────┘     └──────┬──────┘    └─────┬─────┘
         │  超长裁切/定期   │  /compact 触发   │ 自动提取
         └───── 折叠 ──────┴────────── 进入 ──┘
```

### 7.2 会话恢复

- 会话以 JSON 文件存储在 `~/.aura-code/sessions/<id>.json`
- 启动时 `--resume` 或 `/resume` 恢复上次会话
- 会话列表：`--list-sessions`

### 交付标准

- [ ] 会话自动保存到磁盘
- [ ] `/compact` 手动压缩上下文
- [ ] 自动裁切：超过 token 上限时自动摘要旧对话
- [ ] `--resume` 恢复上次会话
- [ ] system prompt 自动注入项目上下文（README、git branch 等）

---

## Phase 8 — Token 计费与成本追踪

**目标**：实时追踪 token 使用与费用，对标 Claude Code `cost-tracker.ts`。

### 模块清单

```
src/services/
└── cost-tracker.ts      # 全局单例，累计 prompt/completion tokens + 费用换算
```

### 关键设计

| 项目 | 说明 |
|---|---|
| 数据来源 | 解析每次 LLM 响应的 `usage` 字段 |
| 费率 | 可配置 `COST_PER_1K_INPUT` / `COST_PER_1K_OUTPUT`，默认 DeepSeek 价格 |
| 显示 | 每次回复结束后在右下角浅色显示 token 数；`/cost` 显示详情 |
| 持久化 | 可选写入 `~/.aura-code/usage.json`，按日汇总 |

### 交付标准

- [ ] 每轮对话后显示本轮 token 消耗
- [ ] `/cost` 显示累计消耗与估算费用

---

## Phase 9 — MCP 协议集成

**目标**：连接外部 MCP Server，动态发现并调用第三方工具，对标 Claude Code `services/mcp/`。

### 模块清单

```
src/services/mcp/
├── mcp-pool.ts          # MCP 连接池：管理多个 MCP server 连接
├── mcp-discovery.ts     # 工具发现：listTools() + 缓存
├── mcp-tool-adapter.ts  # 将 MCP tool 适配为 ToolDefinition 注册到 ToolRegistry
└── mcp-config.ts        # MCP 配置文件解析（~/.aura-code/mcp.json）
```

### 配置格式

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." }
    }
  }
}
```

### 关键设计

- 使用 `@modelcontextprotocol/sdk` 的 `StdioClientTransport` 连接 MCP server。
- 启动时并行初始化所有配置的 MCP server。
- `listTools()` 带 TTL 缓存（60s），避免重复查询。
- 每个 MCP tool 自动适配为 `ToolDefinition`，动态注册到 `ToolRegistry`，LLM 可像原生工具一样使用。

### 交付标准

- [ ] 可通过配置文件声明 MCP server
- [ ] 启动时自动连接并发现工具
- [ ] LLM 可无感调用 MCP 提供的工具
- [ ] `/mcp` 命令查看 MCP server 连接状态

---

## Phase 10 — 子代理与多代理协调

**目标**：支持 LLM 拆分子任务并行处理，对标 Claude Code `AgentTool` + `coordinator/`。

### 模块清单

```
src/engine/
├── agent.ts             # AgentTool：生成子代理（独立 QueryEngine 实例）
└── coordinator.ts       # 多代理协调器：任务拆分、结果合并、上下文隔离
```

### 关键设计

| 概念 | 说明 |
|---|---|
| 子代理 | 独立的 QueryEngine 实例，拥有独立 messages 历史，与父代理共享工具注册表 |
| 生成方式 | LLM 调用 `AgentTool`，传入子任务描述；子代理自动运行至完成 |
| 结果回传 | 子代理最终输出作为 `tool_result` 返回父代理 |
| 并行 | 多个 `AgentTool` 调用可 `Promise.all` 并行（Phase 4 已支持并行工具） |
| 资源限制 | 每个子代理最多 15 轮工具调用、独立 token 计数 |

### 交付标准

- [ ] LLM 可通过 AgentTool 分派子任务
- [ ] 子代理独立执行并返回结果
- [ ] 父代理收到子代理结果后继续对话

---

## Phase 11 — 高级特性（渐进式）

以下特性按优先级排列，可在核心功能稳定后逐步添加。

### 11.1 插件系统

```
src/plugins/
├── loader.ts            # 插件加载器：扫描 ~/.aura-code/plugins/ 目录
├── plugin.ts            # Plugin 接口定义
└── builtin/             # 内置插件
```

- 插件可注册新的 Tool 和 Command
- 插件描述文件 `plugin.json`：`name`, `version`, `tools[]`, `commands[]`

### 11.2 Skill 系统

```
src/skills/
├── skill-runner.ts      # Skill 执行器：读取 SKILL.md → 注入到 system prompt
└── skill-store.ts       # Skill 发现与管理
```

- Skill = 可复用的 prompt 模板 + 工作流描述
- 用户可在 `~/.aura-code/skills/` 创建自定义 skill

### 11.3 IDE Bridge

```
src/bridge/
├── bridge-server.ts     # WebSocket/stdio 服务端
├── bridge-protocol.ts   # 消息协议定义
└── bridge-auth.ts       # JWT 认证
```

- 双向通信层，VS Code / JetBrains 扩展可连接
- 支持 IDE 端发送编辑请求、接收工具调用结果

### 11.4 Git Worktree 隔离

- `EnterWorktreeTool` / `ExitWorktreeTool`
- 危险操作前自动创建 git worktree，失败可回滚
- 对标 Claude Code 的 worktree 模式

### 11.5 Proactive 模式

- 后台监听文件变化
- 检测到错误自动提出修复建议
- 对标 Claude Code 的 `PROACTIVE` feature flag

### 11.6 终端 UI 升级（Ink）

- 从 readline 迁移到 React + Ink
- 支持多面板、进度条、可折叠的工具输出
- 对标 Claude Code 的 140+ 组件体系

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| Runtime | Node.js 20+ | 与 monorepo 一致；后期可评估 Bun |
| Language | TypeScript (strict) | `"strict": true` |
| LLM API | DeepSeek OpenAI 兼容 | `POST /v1/chat/completions` |
| Schema 校验 | Zod | 工具输入校验 + 配置校验 |
| 终端 UI | readline → Ink（Phase 11） | MVP 用 readline，后期可选升级 |
| 终端样式 | chalk | ANSI 颜色 |
| 文件搜索 | glob (npm) | `GlobTool` |
| 内容搜索 | ripgrep (系统) | `GrepTool` 调用 `rg` |
| MCP | @modelcontextprotocol/sdk | Phase 9 |
| 包管理 | pnpm workspace | 复用 monorepo 体系 |

---

## 目录结构全览（最终形态）

```
apps/aura-code/
├── package.json
├── tsconfig.json
├── README.md
├── ROADMAP.md                   # ← 本文件
│
└── src/
    ├── main.ts                  # Phase 0  入口
    ├── cli.ts                   # Phase 0  CLI 参数解析
    ├── config.ts                # Phase 0  配置管理
    │
    ├── types/
    │   └── index.ts             # Phase 0  共享类型
    │
    ├── services/
    │   ├── llm/
    │   │   ├── client.ts        # Phase 1  LLM HTTP 客户端
    │   │   ├── sse-parser.ts    # Phase 1  SSE 解析
    │   │   ├── token-estimator.ts  # Phase 1  Token 估算
    │   │   └── types.ts         # Phase 1  LLM 类型
    │   │
    │   ├── memory/
    │   │   ├── session-store.ts    # Phase 7  会话持久化
    │   │   ├── context-builder.ts  # Phase 7  上下文组装
    │   │   ├── compactor.ts        # Phase 7  上下文压缩
    │   │   └── project-context.ts  # Phase 7  项目信息收集
    │   │
    │   ├── mcp/
    │   │   ├── mcp-pool.ts         # Phase 9  MCP 连接池
    │   │   ├── mcp-discovery.ts    # Phase 9  工具发现
    │   │   ├── mcp-tool-adapter.ts # Phase 9  工具适配
    │   │   └── mcp-config.ts       # Phase 9  MCP 配置
    │   │
    │   └── cost-tracker.ts      # Phase 8  费用追踪
    │
    ├── tools/
    │   ├── tool.ts              # Phase 3  Tool 接口 + Registry
    │   ├── bash.ts              # Phase 3  Shell 执行
    │   ├── file-read.ts         # Phase 3  文件读取
    │   ├── file-write.ts        # Phase 3  文件写入
    │   ├── file-edit.ts         # Phase 3  文件编辑
    │   ├── glob.ts              # Phase 3  文件搜索
    │   └── grep.ts              # Phase 3  内容搜索
    │
    ├── engine/
    │   ├── query-engine.ts      # Phase 4  核心循环
    │   ├── message-builder.ts   # Phase 4  消息组装
    │   ├── context.ts           # Phase 4  系统上下文
    │   ├── permissions.ts       # Phase 5  权限系统
    │   ├── agent.ts             # Phase 10 子代理
    │   └── coordinator.ts       # Phase 10 多代理协调
    │
    ├── commands/
    │   ├── registry.ts          # Phase 6  命令注册表
    │   ├── help.ts              # Phase 6
    │   ├── clear.ts             # Phase 6
    │   ├── compact.ts           # Phase 6
    │   ├── cost.ts              # Phase 6
    │   ├── diff.ts              # Phase 6
    │   ├── tools.ts             # Phase 6
    │   ├── model.ts             # Phase 6
    │   └── config.ts            # Phase 6
    │
    ├── ui/
    │   ├── repl.tsx             # Phase 2  Ink 入口
    │   ├── chat-app.tsx         # Phase 2  主界面
    │   ├── session-options.ts  # Phase 2  会话类型
    │   ├── spinner.ts           # Phase 2  加载动画（可选）
    │   ├── markdown-render.ts   # Phase 2  Markdown 渲染
    │   └── theme.ts             # Phase 2  颜色主题
    │
    ├── plugins/                 # Phase 11.1
    ├── skills/                  # Phase 11.2
    ├── bridge/                  # Phase 11.3
    └── utils/
        └── index.ts             # 通用工具函数
```

---

## 里程碑与交付节奏

| 里程碑 | Phase | 预期能力 |
|---|---|---|
| **M0 · 能跑** | 0 + 1 + 2 | 终端内对话，流式输出 |
| **M1 · 能干活** | 3 + 4 + 5 | LLM 自主读写文件、执行命令、搜索代码 |
| **M2 · 好用** | 6 + 7 + 8 | 斜杠命令、会话持久化、成本追踪 |
| **M3 · 强大** | 9 + 10 | MCP 外部工具、子代理并行 |
| **M4 · 生态** | 11.x | 插件、技能、IDE 集成、高级 UI |

---

## 与 Claude Code 架构的取舍说明

| Claude Code 设计 | aura-code 取舍 | 原因 |
|---|---|---|
| Bun runtime | Node.js | monorepo 已用 Node；Bun 可后期评估 |
| React + Ink UI (140 组件) | readline → 后期 Ink | MVP 不需要复杂 UI；降低启动成本 |
| Anthropic API (原生 tool_use) | DeepSeek OpenAI 兼容 API | 统一 monorepo 的 LLM provider |
| Fenced-code 沙盒执行 MCP | 原生 tool_calls + MCP SDK | DeepSeek 支持 OpenAI tools 格式，不需要 fenced-code 绕行 |
| GrowthBook feature flags | 环境变量 | 单机 CLI 不需要远端 feature flag 服务 |
| OAuth + Keychain 认证 | .env API key | 单用户 CLI，不需要 OAuth |
| OpenTelemetry + gRPC 遥测 | console.log + 本地 JSON | MVP 不需要分布式遥测 |
| 46K 行 QueryEngine | 精简至 ~500 行 | 保留核心循环，去除 Anthropic 特有逻辑 |
