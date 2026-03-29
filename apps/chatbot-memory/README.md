# chatbot-memory

**知忆**：带**会话记忆**的聊天**网页应用**（浏览器 UI / Vite + Express API + DeepSeek OpenAI 兼容接口）。助手消息使用 **Markdown** 渲染（`marked` + `DOMPurify` 消毒）。

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
| POST | `/api/chat` | Body: `{ "message": "..." }`，Header: `X-Session-Id`（可选）。响应为 **SSE**（`text/event-stream`），每条 `data:` 为 JSON：`{ "text": "片段" }`；MCP 路径上可有 `{ "phase": "..." }`；结束为 `{ "done": true }`，错误为 `{ "error": "..." }` |
| POST | `/api/clear` | 清空该 `X-Session-Id` 对应会话的逐轮记忆与摘要层（**不**删除会话条目） |
| GET | `/api/sessions` | 列出会话：`{ "sessions": [ { "id", "title", "updatedAt" } ] }` |
| POST | `/api/sessions` | 新建空会话，返回 `{ "id" }` |
| GET | `/api/sessions/:sessionId` | 返回该会话的 `turns`、`summary`、`facts`、`title`、`updatedAt`；若有过折叠归档则另有 **`foldArchiveLinks`**：`[{ "index", "mode", "createdAt" }]`，与下面 `fold-archives/:index` **一一对应**（按时间顺序追加） |
| GET | `/api/sessions/:sessionId/fold-archives` | 被摘要/裁切**移出上下文前**的原文归档索引：`{ "enabled", "entries": [{ "index", "mode", "createdAt", "pairCount", "charCount", "previewUser", "summaryBeforePreview"? }] }` |
| GET | `/api/sessions/:sessionId/fold-archives/:index` | 按 `index` 取该批次：完整 `turns`；并含与摘要的**强关联字段**（若已折叠完成）：`summaryBefore`、`factsBefore`、`summaryAfter`、`factsAfter`（分别对应该轮折叠前/合并写入会话后的会话层文本） |
| PATCH | `/api/sessions/:sessionId` | Body: `{ "title": "..." }` 重命名 |
| DELETE | `/api/sessions/:sessionId` | 删除整个会话 |
| GET | `/api/user-facts` | 用户级长期事实（跨会话）：`{ "facts": "每行一条\n..." }` |
| PATCH | `/api/user-facts` | Body: `{ "facts": "..." }` 整体替换并持久化 |
| DELETE | `/api/user-facts` | 清空用户级事实（不影响各会话条目） |

## 环境变量

除根目录 `.env` 中的 DeepSeek 相关变量外，服务端还可设置：

| 变量 | 说明 |
|------|------|
| `PORT` | 开发默认 `5173`；生产 `pnpm start` 默认 `3001` |
| `CHAT_SESSION_STORE_PATH` | 会话存储路径：未设置时默认为目录 `~/.chatbot-memory/sessions/`（每会话一个 `<uuid>.json`，另有 `manifest.json` 索引；仅变更的会话会重写）。若路径以 `.json` 结尾则使用旧版**单文件**全量写入（兼容已有部署） |
| `CHAT_FOLD_ARCHIVE_DIR` | 可选。折叠原文归档根目录；默认与会话库**父目录**下的 `fold-archives/`（每会话子目录，内含 `_index.json` 与按序号的 `1.json`…全文） |
| `CHAT_FOLD_ARCHIVE_ENABLE` | 设为 `false` / `0` / `no` 关闭上述归档（默认开启） |
| `CHAT_FOLD_ARCHIVE_INJECT` | 归档开启时：是否每轮对话把若干批归档节选**自动拼入**发给模型的 system（默认 `true`；`false` 可省 token，仅靠 API 人工查归档） |
| `CHAT_FOLD_ARCHIVE_INJECT_SELECT` | 选哪些批次注入：`relevant`（默认）按**本轮用户输入**与归档全文做 **lexical** 重合打分（英文/数字词 + 汉字二元组命中）；`recent` 则始终按时间取最近若干条（与输入无关） |
| `CHAT_FOLD_ARCHIVE_INJECT_RELEVANCE_FALLBACK` | `SELECT=relevant` 且与所有归档**lexical 分均为 0** 时：`recent`（默认）回退为按时间取最近几条；`none` 则本轮**不注入**任何归档 |
| `CHAT_FOLD_ARCHIVE_INJECT_MAX_ENTRIES` | 自动注入时最多包含几条归档批次（默认 `6`） |
| `CHAT_FOLD_ARCHIVE_INJECT_MAX_CHARS` | 自动注入正文总字符上限（默认 `12000`） |
| `CHAT_FOLD_ARCHIVE_INJECT_TURNS_MAX_CHARS` | 每条归档内「原文节选」字符上限（默认 `3500`） |
| `CHAT_USER_FACTS_PATH` | 用户级事实 JSON 路径；默认 `~/.chatbot-memory/user-facts.json` |
| `CHAT_USER_FACTS_MAX_LINES` | 用户级事实最多保留行数（默认 `200`，超出保留末尾） |
| `CHAT_USER_FACTS_PROMOTE_LLM` | 记忆折叠后是否再调模型筛出「可跨会话」要点写入用户级事实（默认 `false`，仅合并本会话 facts 新增行） |
| `CHAT_USER_FACTS_PROMOTE_MODEL` | 上述筛选所用模型；未设置则用主对话 `DEEPSEEK_MODEL` |
| `CHAT_MCP_SANDBOX_POOL_SIZE` | MCP 代码沙盒**子进程池**容量（默认 `4`）；成功执行后复用子进程以降低 fork 开销。`0` 表示每次执行新建子进程（旧行为）。详见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) |

## 文档

- **架构说明**（主流程与核心实现）：[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
