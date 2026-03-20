# ai-agent-family

基于 **pnpm workspaces** + **Lerna** 的 monorepo。依赖安装与链接由 pnpm 负责；Lerna 用于跨包脚本（`lerna run`）、版本与发布等。

## 要求

- Node.js 18+（Lerna 9 官方 engines 为 Node 20.19+ / 22.12+ / 24+，建议使用 **20.19+**）
- 启用 Corepack 后使用锁定的 pnpm 版本（见根目录 `package.json` 的 `packageManager` 字段）

```bash
corepack enable
pnpm install
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm run build` | 在所有包中执行 `build` 脚本 |
| `pnpm run test` | 在所有包中执行 `test` 脚本 |
| `pnpm run list` | 列出所有包（含 `private: true`，等价于 `lerna list --all`） |
| `pnpm run create` | 交互式创建新包（`lerna create`） |
| `pnpm add <pkg> -w` | 向**仓库根**添加开发依赖 |
| `pnpm add <pkg> --filter @ai-agent-family/example` | 向指定 workspace 包添加依赖 |

默认的 `lerna list`（不带 `--all`）**不会列出** `package.json` 里 `"private": true` 的包；本地私有包请用 `pnpm run list` 或 `lerna la`。

## 布局

- `pnpm-workspace.yaml`：pnpm 的 workspace 声明（与 Lerna 共用同一批 glob）
- `lerna.json`：`npmClient: pnpm`，并显式配置 `packages`
- `packages/*`：子包目录；示例为 `packages/example`（可删可改）

Lerna 9 通过 **Nx** 调度任务（终端里会看到 “Lerna (powered by Nx)”）。根目录的 `nx.json` 由 `nx init` 生成，用于识别 workspace 中的项目。

## 新包

在 `packages/` 下新建目录并添加 `package.json`，或执行：

```bash
pnpm run create
```

确保包名与 `pnpm-workspace.yaml` 中的 glob 一致（当前为 `packages/*`）。
