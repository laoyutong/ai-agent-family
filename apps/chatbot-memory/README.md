# chatbot-memory

**知忆**：带**会话记忆**的聊天**网页应用**（浏览器 UI / Vite + Express API + LangChain / DeepSeek）。助手消息使用 **Markdown** 渲染（`marked` + `DOMPurify` 消毒）。

## 准备

在**仓库根目录**配置 `DEEPSEEK_API_KEY`（复制 `.env.example` 为 `.env`），然后在仓库根目录执行：

```bash
pnpm install
```

## 开发（一条命令同时跑前端 + API）

```bash
cd apps/chatbot-memory
pnpm dev
```

浏览器打开 **http://127.0.0.1:5173**（同一进程、同一端口：Vite 中间件 + `/api`）。

可用环境变量 `PORT` 改端口（默认 `5173`）。

## 生产

```bash
cd apps/chatbot-memory
pnpm build
pnpm start
```

访问 **http://127.0.0.1:3001**（可用 `PORT` 改端口）。

## API（供前端或脚本调用）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat` | Body: `{ "message": "..." }`，Header: `X-Session-Id`（可选）。响应为 **SSE**（`text/event-stream`），每条 `data:` 为 JSON：`{ "text": "片段" }`，结束为 `{ "done": true }`，错误为 `{ "error": "..." }` |
| POST | `/api/clear` | 清空该 `X-Session-Id` 对应会话的逐轮记忆与摘要层（**不**删除会话条目） |
| GET | `/api/sessions` | 列出会话：`{ "sessions": [ { "id", "title", "updatedAt" } ] }` |
| POST | `/api/sessions` | 新建空会话，返回 `{ "id" }` |
| GET | `/api/sessions/:sessionId` | 返回该会话的 `turns`、`summary`、`facts`、`title`、`updatedAt` |
| PATCH | `/api/sessions/:sessionId` | Body: `{ "title": "..." }` 重命名 |
| DELETE | `/api/sessions/:sessionId` | 删除整个会话 |

## 环境变量

除根目录 `.env` 中的 DeepSeek 相关变量外，服务端还可设置：

| 变量 | 说明 |
|------|------|
| `PORT` | 开发默认 `5173`；生产 `pnpm start` 默认 `3001` |
| `CHAT_SESSION_STORE_PATH` | 会话存储路径：未设置时默认为目录 `~/.chatbot-memory/sessions/`（每会话一个 `<uuid>.json`，另有 `manifest.json` 索引；仅变更的会话会重写）。若路径以 `.json` 结尾则使用旧版**单文件**全量写入（兼容已有部署） |

## 文档

架构分析、路线图与 MCP 工作流程见 [`docs/`](./docs/README.md)（含与实现对齐的迭代说明）。
