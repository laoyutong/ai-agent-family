# aura-code

aura-code: Terminal AI Programming Assistant — 基于 DeepSeek API 构建的终端编程助手。

## 定位

一个运行在终端的 **agentic coding assistant**：用户用自然语言描述任务，LLM 自主调用工具（读写文件、执行命令、搜索代码）完成编程工作。

aura-code 是一个完整的终端编程助手实现，具备完整的工具系统和命令系统，支持复杂的编程任务。

## 状态

🚧 **开发中** — 当前处于项目骨架阶段，核心功能尚未实现。

## 快速开始

```bash
# 在 monorepo 根目录
pnpm install

# 确保根目录 .env 中配置了 DEEPSEEK_API_KEY
cp .env.example .env

# 开发模式启动
pnpm --filter aura-code dev

# 构建
pnpm --filter aura-code build
```

## 核心架构

```
用户输入（自然语言）
      ↓
  QueryEngine（核心循环）
      ↓
  LLM 流式调用（DeepSeek API，带 tools[]）
      ↓
  ┌── 纯文本 → 流式输出到终端
  └── tool_calls → 权限检查 → 执行工具 → 结果回传 LLM → 继续循环
```

### 工具系统

| 工具 | 说明 |
|---|---|
| BashTool | Shell 命令执行 |
| FileReadTool | 文件读取（支持行号范围） |
| FileWriteTool | 文件创建/覆盖 |
| FileEditTool | 精确字符串替换编辑 |
| GlobTool | 文件名模式搜索 |
| GrepTool | ripgrep 内容搜索 |

### 命令系统

| 命令 | 说明 |
|---|---|
| `/help` | 显示可用命令 |
| `/clear` | 清空会话 |
| `/compact` | 压缩上下文 |
| `/cost` | 显示 token 消耗 |
| `/diff` | 查看本次修改 |
| `/tools` | 列出可用工具 |

## 实现路线

完整实现路线图见 [ROADMAP.md](./ROADMAP.md)，包含 12 个递进阶段：

| 里程碑 | 能力 |
|---|---|
| M0 · 能跑 | 终端对话，流式输出 |
| M1 · 能干活 | 自主读写文件、执行命令、搜索代码 |
| M2 · 好用 | 斜杠命令、会话持久化、成本追踪 |
| M3 · 强大 | MCP 外部工具、子代理并行 |
| M4 · 生态 | 插件、技能、IDE 集成 |

## 技术栈

- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict)
- **TUI**: React 19 + Ink 6（`ink-text-input`、`ink-spinner`）
- **LLM**: DeepSeek OpenAI 兼容 API
- **Schema**: Zod
- **搜索**: ripgrep (rg)
- **协议**: MCP (Model Context Protocol)
