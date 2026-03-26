# 贡献与提交说明

## Git 提交信息

本仓库采用与 [Conventional Commits](https://www.conventionalcommits.org/) 相近的风格。

- **第一行（summary）**：`type(scope): 简短描述`。`type` 例如 `feat`、`fix`、`docs`、`chore`、`refactor`；`scope` 可选，表示影响范围（如 `chatbot-memory`）。subject 可用中文或英文，保持简洁。
- **正文（可选）**：用短列表列出让评审者需要的要点；无需复述 diff 里显而易见的重命名。

### 请勿使用的内容

- **不要**在提交末尾附工具或自动生成脚注，例如 `Made-with: Cursor`、`Generated-by:` 等。若编辑器自动插入，请在提交前删除，或在对应工具设置中关闭。
- **`Co-authored-by:`**：仅在实际有他人共同撰写该提交时使用；不要为 AI / 助手添加虚构联署。

### 示例

```
feat(chatbot-memory): MCP 多步 Plan-Execute 编排

- 新增 mcp-plan-execute：规划与 json 解析
- chat-mcp-tools：分步沙盒执行与单段路径回退
- 文档与 .env.example 补充 CHAT_MCP_PLAN_*
```
