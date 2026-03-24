/** 启动前校验 `DEEPSEEK_API_KEY`，缺失则打印说明并退出进程 */
export function requireDeepseekApiKey(): void {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error(
      "缺少 DEEPSEEK_API_KEY：请在仓库根目录配置 .env（参考 .env.example）",
    );
    process.exit(1);
  }
}
