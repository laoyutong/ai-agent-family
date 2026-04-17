import React, { memo, useCallback, useRef, useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.js";
import type { PendingPermissionRequest } from "../types/index.js";

export type PermissionChoice = "allow" | "allow-once" | "deny";

export type PermissionPromptProps = {
  request: PendingPermissionRequest;
  onResolve: (choice: PermissionChoice, feedback?: string) => void;
};

/**
 * 权限确认框 - 重新设计版
 * 参考 claude-code-study origin 实现
 *
 * 特性：
 * - 清晰的视觉层次（标题、危险标识、描述）
 * - 三个选项：允许一次 / 总是允许 / 拒绝
 * - Tab 键展开反馈输入框
 * - Esc 键取消
 * - 方向键切换选项
 */
export const PermissionPrompt = memo(function PermissionPrompt(
  props: PermissionPromptProps
): React.JSX.Element {
  const { request, onResolve } = props;

  // 选项状态：0 = 允许一次, 1 = 总是允许, 2 = 拒绝
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState("");
  const resolvedRef = useRef(false);

  const options = useMemo(
    () => [
      { value: "allow-once" as const, label: "允许一次", hint: "Y" },
      { value: "allow" as const, label: "总是允许此工具", hint: "A" },
      { value: "deny" as const, label: "拒绝", hint: "N" },
    ],
    []
  );

  const resolve = useCallback(
    (choice: PermissionChoice) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      const trimmedFeedback = feedback.trim();
      onResolve(choice, trimmedFeedback || undefined);
    },
    [onResolve, feedback]
  );

  useInput(
    (input, key) => {
      // 已解析则忽略所有输入
      if (resolvedRef.current) return;

      // 忽略所有鼠标事件序列（点击、滚动、拖动等）
      // \x1b[< 是 SGR 鼠标协议，\x1b[M 是 X10 鼠标协议
      if (input.startsWith("\x1b[") || input.startsWith("\x1b[M")) {
        return;
      }

      // 忽略鼠标按键释放事件
      if (input.includes("\x1b[")) {
        return;
      }

      // Ctrl+C 始终允许传播（用于退出应用）
      if (key.ctrl && input === "c") {
        return;
      }

      // Esc 取消（等同于拒绝）
      if (key.escape) {
        resolve("deny");
        return;
      }

      // Tab 切换反馈输入模式
      if (key.tab) {
        setFeedbackMode((prev) => !prev);
        return;
      }

      // 在反馈输入模式下处理输入
      if (feedbackMode) {
        if (key.return) {
          resolve(options[selectedIndex]!.value);
        } else if (key.backspace || key.delete) {
          setFeedback((prev) => prev.slice(0, -1));
        } else if (input && input.length === 1 && !key.ctrl && !key.meta) {
          setFeedback((prev) => prev + input);
        }
        return;
      }

      // 方向键切换选项
      if (key.upArrow) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : options.length - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((prev) => (prev < options.length - 1 ? prev + 1 : 0));
        return;
      }

      // Enter 确认
      if (key.return) {
        resolve(options[selectedIndex]!.value);
        return;
      }

      // 单字符快捷键
      if (input.length === 1 && !key.ctrl && !key.meta) {
        const lower = input.toLowerCase();
        if (lower === "y") {
          resolve("allow-once");
          return;
        }
        if (lower === "a") {
          resolve("allow");
          return;
        }
        if (lower === "n") {
          resolve("deny");
          return;
        }
      }
    },
    { isActive: true }
  );

  // 判断是否为危险操作
  const isDangerous =
    request.toolName === "run_command" ||
    request.toolName === "write_file" ||
    request.toolName === "search_replace";

  // 获取工具中文名称
  const toolNameCN = useMemo(() => {
    const map: Record<string, string> = {
      write_file: "写入文件",
      search_replace: "修改文件",
      run_command: "执行命令",
      read_file: "读取文件",
      glob_files: "查找文件",
      grep_content: "搜索内容",
    };
    return map[request.toolName] ?? request.toolName;
  }, [request.toolName]);

  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      borderStyle="round"
      borderColor={isDangerous ? "red" : "yellow"}
      paddingX={1}
      paddingY={1}
    >
      {/* 标题栏 */}
      <Box flexDirection="row" gap={1} marginBottom={1}>
        <Text bold color={isDangerous ? "red" : "yellow"}>
          {isDangerous ? "⚠️ 危险操作" : "⚡ 需要确认"}
        </Text>
        <Text dimColor>({toolNameCN})</Text>
      </Box>

      {/* 描述 */}
      <Box marginBottom={1} paddingX={1}>
        <Text color={theme.assistant} wrap="wrap">
          {request.description}
        </Text>
      </Box>

      {/* 参数详情（可选展开） */}
      {Object.keys(request.args).length > 0 && (
        <Box
          flexDirection="column"
          marginBottom={1}
          paddingX={1}
          borderStyle="single"
          borderDimColor
        >
          {Object.entries(request.args).map(([key, value]) => (
            <Text key={key} dimColor wrap="wrap">
              <Text bold>{key}:</Text>{" "}
              {typeof value === "string" ? value : JSON.stringify(value)}
            </Text>
          ))}
        </Box>
      )}

      {/* 选项列表 */}
      <Box flexDirection="column" marginTop={1} gap={0}>
        {options.map((opt, idx) => {
          const isSelected = idx === selectedIndex;
          const color =
            opt.value === "deny" ? "red" : opt.value === "allow" ? "green" : "cyan";
          return (
            <Box key={opt.value} flexDirection="row" gap={1}>
              <Text color={isSelected ? color : "gray"}>
                {isSelected ? "●" : "○"}
              </Text>
              <Text color={isSelected ? color : "gray"} bold={isSelected}>
                {opt.label}
              </Text>
              <Text dimColor>({opt.hint})</Text>
            </Box>
          );
        })}
      </Box>

      {/* 反馈输入框 */}
      {feedbackMode && (
        <Box marginTop={1} paddingX={1}>
          <Text color="blue">
            反馈: {feedback}
            <Text color="blue">▍</Text>
          </Text>
        </Box>
      )}

      {/* 底部提示 */}
      <Box marginTop={1} paddingX={1}>
        <Text dimColor>
          ↑↓ 选择 · Enter 确认 · {feedbackMode ? "Tab 关闭输入" : "Tab 反馈"} · Esc 取消
        </Text>
      </Box>
    </Box>
  );
});
