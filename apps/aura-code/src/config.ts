import path from "node:path";
import { z } from "zod";
import type { AppConfig, CliOptions } from "./types/index.js";

const envSchema = z.object({
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().optional(),
  DEEPSEEK_MODEL: z.string().optional(),
});

export function buildAppConfig(cli: CliOptions): AppConfig {
  const env = envSchema.parse(process.env);
  const apiKey = env.DEEPSEEK_API_KEY?.trim() ?? "";
  const baseUrl =
    env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
  const model =
    cli.model.trim() ||
    env.DEEPSEEK_MODEL?.trim() ||
    "deepseek-v4-flash";
  return {
    apiKey,
    baseUrl,
    model,
    cwd: path.resolve(cli.cwd),
  };
}

export function requireApiKey(config: AppConfig): void {
  if (!config.apiKey) {
    console.error(
      "缺少 DEEPSEEK_API_KEY：请在仓库根目录配置 .env（参考 .env.example）。",
    );
    process.exit(1);
  }
}
