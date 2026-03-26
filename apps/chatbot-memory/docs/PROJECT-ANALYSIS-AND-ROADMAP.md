# 知忆（chatbot-memory）项目分析与路线图

本文档系统整理对 **chatbot-memory** 的架构诊断：**可优化的现有链路**、**有复杂度的功能新增方向**，以及**优先级建议**。分析基于仓库当前实现（Vite + Express、DeepSeek 流式、**按会话分文件的**本地持久化、MCP 代码沙盒、熵过滤与记忆折叠等）。**§2.1 / §2.2 中标注「已实现」的条目已与代码对齐**；修订见 §六。

---

## 一、项目概览

| 维度 | 说明 |
|------|------|
| 定位 | 浏览器端「知忆」：多会话、本地持久化、可选 MCP 工具 |
| 技术栈 | TypeScript、Vite 6、Express 4、DeepSeek（OpenAI 兼容 API）、`@modelcontextprotocol/sdk` |
| 记忆模型 | `turns`（近期逐轮）+ `summary` / `facts`（折叠后的长期层） |
| MCP 集成 | 非原生 `tools` API：通过「生成代码 → `node:vm` 沙盒 → `callTool`」驱动 |

---

## 二、现有链路优化分析

### 2.1 请求链路中的 LLM 调用扇出（高优先级）

一条用户消息在最坏情况下仍可能触发 **多次非流式调用** 后才开始流式输出（启发式与并行化已减轻常见路径的扇出与等待）：

```
用户消息
  → [1] 熵过滤 (filterDialogueByEntropyPrinciple) — 非流式（与 listTools 并行，见下）
  → [2] MCP 路由：启发式 inferMcpRouteByHeuristic 或 LLM 路由 (shouldUseMcpSandboxForTurn) — 非流式（二选一或跳过）
  → [3~N] MCP 代码生成 + 沙盒执行 (最多 16 轮) — 每轮非流式
  → [N+1] 最终流式回复
  → [后台] 摘要折叠 (foldDroppedIntoLayers) — 非流式
```

**已实现：**

- **熵过滤与 `listTools()` 并行**：在需要熵过滤且需要拉取 MCP 工具列表时，`Promise.all` 同时等待两者，降低首字前的 wall-clock（`chatbot.ts`）。
- **路由判断本地化**：`inferMcpRouteByHeuristic`（`chat-mcp-tools.ts`）在调用路由 LLM 前做关键词/正则预判；明显工具/文件意图 → 直接走 MCP 沙盒；明显极短寒暄 → 跳过 MCP（不 `listTools`、不调路由 LLM）；不明确才调用 `shouldUseMcpSandboxForTurn`。环境变量 `CHAT_MCP_ROUTER_HEURISTIC`（默认 `true`）可关闭，恢复「凡需路由则必调 LLM」。
- **一致性**：路由 LLM 与主对话仍使用 **熵过滤之后** 的 `userContentForApi` 组装 `messages`，与预判使用的原始输入分工明确（预判仅用于是否走 MCP / 是否拉工具）。

**仍可优化：**

- **MCP 首轮体验**：代码生成阶段向前端推送进度类事件（见 §3.4「流式 MCP 进度反馈」）。

---

### 2.2 会话持久化的单文件瓶颈

**原问题：** 所有会话挤在 **单个 JSON** 中，任意会话变更即全库重写。

**已实现（`session-store.ts`）：**

- 默认目录 **`~/.chatbot-memory/sessions/`**：每会话 `<uuid>.json` 存正文，`manifest.json` 存 `id → { title, updatedAt }`；仅 **脏会话** 与 manifest 重写。
- 环境变量 **`CHAT_SESSION_STORE_PATH`**：路径以 **`.json` 结尾** 时仍为 **旧版单文件全量** 写入（兼容已有部署）。
- **迁移**：若使用默认目录且尚无 manifest，存在旧版 **`~/.chatbot-memory/sessions.json`** 时一次性迁入目录，原文件重命名为 **`sessions.json.migrated`**。

**可选演进（未实现）：**

- 增量 / WAL、**SQLite**（事务与按需读写，需单独迁移策略）。

---

### 2.3 MCP 代码沙盒安全性

实现使用 Node.js **`node:vm`**。官方文档指出 `vm` **不是** 安全隔离边界；模型生成的代码理论上可能通过原型链等方式尝试逃逸（例如借助 `Object` 链访问危险能力）。

**优化方向：**

- 评估 **`isolated-vm`**、**`vm2`**（若维护状态可接受）或 **Worker + 受限环境** 等更强隔离方案。
- 对暴露给沙盒的全局做更严格的冻结与代理封装。
- 在文档中明确「当前威胁模型」：仅信任模型输出时的风险与部署建议。

---

### 2.4 记忆折叠链路的健壮性

折叠通过 `session.foldChain` 串行执行；`dropped` 的对话在 **进入折叠前** 往往已从 `turns` 中移出。若 `foldDroppedIntoLayers` 失败，仅打日志，**可能导致信息既不在 `turns` 也未进入 `summary`/`facts`**。

**优化方向：**

- 折叠失败时将 `dropped` **回灌** 到 `turns` 或写入 `pendingDropped` 待重试缓冲区。
- 对折叠失败增加 **有限次重试**（带退避）。
- 超阈值后 **降级策略**：例如暂停折叠、保留更长 `turns` 窗口，并监控告警。

---

### 2.5 前端渲染与流式体验

客户端在流式过程中对助手气泡 **全量** `renderMarkdown` 更新，高频 chunk 时 DOM 与 Markdown 解析成本较高。

**优化方向：**

- **节流 / `requestAnimationFrame`** 合并更新。
- 长对话时考虑 **虚拟列表** 或仅渲染可视区域。
- 评估 **增量 Markdown** 解析（实现复杂度与库选型需权衡）。

---

## 三、有复杂度的功能新增方向

### 3.1 跨会话知识图谱 / 用户级 Profile

| 项目 | 说明 |
|------|------|
| **复杂度** | 高 |
| **价值** | 高 |
| **现状** | `facts` / `summary` 绑定单会话，无法在会话 B 复用会话 A 中用户声明的偏好。 |
| **思路** | 引入全局 `UserProfile` 或「用户级事实」存储；折叠完成后将可跨会话复用的条目提升；`buildSystemContent` 注入全局层；需 **冲突与过期策略**。 |
| **涉及** | `memory-fold.ts`、`system-content.ts`、`session-store.ts`（或新存储）、`chat-types.ts` |

---

### 3.2 对话分支与版本树（Conversation Branching）

| 项目 | 说明 |
|------|------|
| **复杂度** | 高 |
| **价值** | 中高 |
| **思路** | 将线性 `turns` 改为树结构（父节点、子分支）；每分支可挂独立摘要快照；侧栏/顶栏分支导航与持久化格式升级。 |
| **涉及** | `chat-types.ts`、`chatbot.ts`、`session-store.ts`、客户端 UI 较大改造 |

---

### 3.3 MCP 多步骤 Plan-Execute 编排

| 项目 | 说明 |
|------|------|
| **复杂度** | 高 |
| **价值** | 高 |
| **现状** | 单次「代码 → 执行 →（多轮重试）→ 最终流式」偏线性。 |
| **思路** | 先输出结构化 Plan（JSON 步骤），再逐步执行；步骤间传递结果；可选前端步骤进度展示。 |
| **涉及** | `chat-mcp-tools.ts` 核心扩展、新增 planner 模块、`mcp-facade-prompt.ts` |

---

### 3.4 流式 MCP 执行进度反馈

| 项目 | 说明 |
|------|------|
| **复杂度** | 中 |
| **价值** | 高 |
| **现状** | MCP 路径在代码生成与沙盒执行阶段，前端缺少细粒度状态。 |
| **思路** | 扩展 SSE：`progress` 或结构化事件；沙盒内每次 `callTool` 前后打点；前端展示步骤文案或轻量进度条。 |
| **涉及** | `chat-mcp-tools.ts`、`app.ts`（SSE 协议）、`main.ts`（UI） |

---

### 3.5 多模型路由与 A/B 对比

| 项目 | 说明 |
|------|------|
| **复杂度** | 中 |
| **价值** | 中 |
| **现状** | 仓库名 `ai-agent-family` 暗示多 Agent，但当前主要为单一 DeepSeek 配置。 |
| **思路** | `ModelRegistry`、统一 `LLMClient` 抽象；按任务复杂度或用户设置路由；可选「双模型同题对比」UI。 |
| **涉及** | 新建/重构 `llm-client` 层、`chatbot.ts`、环境变量与配置文档 |

---

### 3.6 会话导出 / 导入与分享

| 项目 | 说明 |
|------|------|
| **复杂度** | 低～中 |
| **价值** | 中 |
| **思路** | 导出 Markdown / JSON / HTML；导入迁移；只读分享链接需鉴权与路由设计。 |

---

### 3.7 第二个应用：Agent Workflow Builder（示例）

| 项目 | 说明 |
|------|------|
| **复杂度** | 高 |
| **价值** | 高（与 monorepo 扩展一致） |
| **思路** | 新增 `apps/agent-builder`：可视化 DAG；节点为 LLM、MCP、分支、循环等；与现有 MCP 能力抽成共享包（如 `packages/*`）后复用。 |

---

## 四、优先级排序建议

| 优先级 | 项目 | 类型 | 理由 |
|--------|------|------|------|
| P0 | LLM 调用扇出并行化 / 路由本地化 | 优化 | **已实现**（§2.1）；进一步可做 SSE 进度（§3.4） |
| P0 | MCP 执行进度反馈（SSE + UI） | 新功能 | MCP 路径等待长，体验提升明显 |
| P1 | 沙盒安全加固 | 优化 | 对齐威胁模型，减少逃逸风险 |
| P1 | 折叠失败数据恢复与重试 | 优化 | 避免「移出 turns 却未写入摘要」的静默丢失 |
| P1 | 跨会话知识 / 用户级 Profile | 新功能 | 与「记忆型」产品定位强相关 |
| P2 | 会话持久化分文件或 SQLite | 优化 | **分文件已实现**（§2.2）；SQLite 仍为可选 |
| P2 | 前端流式渲染节流 / 虚拟列表 | 优化 | 长会话性能与流畅度 |
| P2 | 多模型路由 | 新功能 | 扩展性强，利于多后端 |
| P3 | 对话分支 | 新功能 | 数据结构与会话 UX 改动大 |
| P3 | Agent Workflow Builder | 新功能 | 独立应用，工作量大、战略价值高 |

---

## 五、相关代码与文档索引

| 路径 | 说明 |
|------|------|
| `src/server/chatbot.ts` | 主对话流：熵过滤、MCP 分支、写入 `turns`、入队折叠 |
| `src/server/chat-mcp-tools.ts` | MCP 路由、代码轮次、最终流式 |
| `src/server/mcp-code-sandbox.ts` | `vm` 沙盒与 `callTool` 转发 |
| `src/server/session-store.ts` | 默认按会话分文件 + manifest；可选单文件路径 |
| `src/server/memory-fold.ts` | 摘要 / 要点折叠与 `foldChain` |
| `src/client/main.ts` | 会话 UI、SSE 消费、Markdown 渲染 |
| `docs/MCP-CLIENT.md` | MCP 客户端说明（若与「始终走 MCP」等行为不一致，请以代码为准并考虑同步文档） |

---

## 六、修订记录

| 日期 | 说明 |
|------|------|
| 2025-03-25 | 初版：基于仓库实现的分析与路线图整理 |
| 2025-03-26 | 同步实现状态：§2.1 熵过滤与 listTools 并行、MCP 路由启发式；§2.2 分文件持久化与旧库迁移 |
