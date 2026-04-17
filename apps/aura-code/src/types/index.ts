export type CliOptions = {
  model: string;
  cwd: string;
  prompt?: string;
};

export type AppConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  cwd: string;
};

/** 工具权限级别 */
export type ToolPermissionLevel = "safe" | "dangerous";

/** 权限模式 */
export type PermissionMode = "strict" | "normal" | "loose";

/** 工具权限检查结果 */
export type PermissionCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string; toolName: string; args: Record<string, unknown> };

/** 待确认的权限请求 */
export type PendingPermissionRequest = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
};
