# ai-agent-family

基于 **pnpm workspaces** + **Lerna** 的 monorepo。依赖安装与链接由 pnpm 负责；Lerna 用于跨包脚本（`lerna run`）、版本与发布等。

## 要求

- Node.js 18+（Lerna 9 官方 engines 为 Node 20.19+ / 22.12+ / 24+，建议使用 **20.19+**）
- 启用 Corepack 后使用锁定的 pnpm 版本（见根目录 `package.json` 的 `packageManager` 字段）

```bash
corepack enable
pnpm install
```

API 密钥（当前为 **DeepSeek**）统一放在仓库根目录：复制 `.env.example` 为 `.env` 并填写 `DEEPSEEK_API_KEY`（`.env` 已列入 `.gitignore`，勿提交）。

提交信息约定见根目录 [CONTRIBUTING.md](./CONTRIBUTING.md)（Conventional Commits 风格；勿附 `Made-with:` 等工具脚注）。

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm run build` | 在所有应用中执行 `build` 脚本 |
| `pnpm run test` | 在所有应用中执行 `test` 脚本 |
| `pnpm run list` | 列出所有 workspace 项目（含 `private: true`，等价于 `lerna list --all`） |
| `pnpm run create` | 交互式创建新项目（`lerna create`） |
| `pnpm add <pkg> -w` | 向**仓库根**添加开发依赖 |
| `pnpm add <pkg> --filter chatbot-memory` | 向指定 workspace 应用添加依赖 |

默认的 `lerna list`（不带 `--all`）**不会列出** `package.json` 里 `"private": true` 的项目；本地私有应用请用 `pnpm run list` 或 `lerna la`。

## 布局

- `pnpm-workspace.yaml`：pnpm 的 workspace 声明（与 Lerna 共用同一批 glob）
- `lerna.json`：`npmClient: pnpm`，并显式配置 `packages` 字段（指向 `apps/*`）
- `apps/*`：应用目录（每个子目录为独立 workspace 项目）
- `apps/chatbot-memory`：带会话记忆的聊天网页（Vite + Express + LangChain，见该目录 `README.md`）

Lerna 9 通过 **Nx** 调度任务（终端里会看到 “Lerna (powered by Nx)”）。根目录的 `nx.json` 由 `nx init` 生成，用于识别 workspace 中的项目。

## 新应用

在 `apps/` 下新建目录并添加 `package.json`，或执行：

```bash
pnpm run create
```

确保路径与 `pnpm-workspace.yaml` 中的 glob 一致（当前为 `apps/*`）。
