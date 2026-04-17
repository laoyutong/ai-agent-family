import type { PermissionMode, PendingPermissionRequest } from "../types/index.js";
import { getToolPermissionLevel } from "../tools/registry.js";

// 内存中的白名单：用户选择"总是允许"的工具
const allowedTools = new Set<string>();

/**
 * 添加工具到白名单（用户选择"总是允许"）
 */
export function addAllowedTool(toolName: string): void {
  allowedTools.add(toolName);
}

/**
 * 从白名单移除工具
 */
export function removeAllowedTool(toolName: string): void {
  allowedTools.delete(toolName);
}

/**
 * 检查工具是否在白名单中
 */
export function isToolAllowed(toolName: string): boolean {
  return allowedTools.has(toolName);
}

/**
 * 清空白名单
 */
export function clearAllowedTools(): void {
  allowedTools.clear();
}

/**
 * 从环境变量获取权限模式
 * - strict: 所有工具都需要确认（包括读操作）
 * - normal: 危险操作需要确认（写操作、命令执行）
 * - loose: 无需确认（自动允许）
 */
export function getPermissionMode(): PermissionMode {
  const env = process.env.AURA_CODE_PERMISSION?.trim().toLowerCase();
  if (env === "strict" || env === "loose") return env;
  return "normal";
}

/**
 * 检查工具是否需要用户确认
 */
export function shouldRequestConfirmation(
  toolName: string,
  mode: PermissionMode = getPermissionMode()
): boolean {
  // 先检查白名单
  if (isToolAllowed(toolName)) {
    return false;
  }

  switch (mode) {
    case "strict":
      return true;
    case "loose":
      return false;
    case "normal":
    default:
      return getToolPermissionLevel(toolName) === "dangerous";
  }
}

/**
 * 生成权限请求的描述文本
 */
export function buildPermissionDescription(
  toolName: string,
  args: Record<string, unknown>
): string {
  switch (toolName) {
    case "write_file": {
      const path = String(args.path ?? "");
      return `写入文件: ${path}`;
    }
    case "search_replace": {
      const path = String(args.path ?? "");
      return `修改文件: ${path}`;
    }
    case "run_command": {
      const command = String(args.command ?? "");
      return `执行命令: ${command.slice(0, 60)}${command.length > 60 ? "..." : ""}`;
    }
    default:
      return `执行 ${toolName}`;
  }
}

/**
 * 创建权限请求对象
 */
export function createPermissionRequest(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>
): PendingPermissionRequest {
  return {
    toolCallId,
    toolName,
    args,
    description: buildPermissionDescription(toolName, args),
  };
}

/**
 * 格式化权限提示信息用于显示
 */
export function formatPermissionPrompt(request: PendingPermissionRequest): string {
  const level = getToolPermissionLevel(request.toolName);
  const levelTag = level === "dangerous" ? "[危险]" : "[确认]";
  return `${levelTag} ${request.description}`;
}
