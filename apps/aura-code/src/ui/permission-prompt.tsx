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
 * 权限确认框 - 简洁版
 */
export const PermissionPrompt = memo(function PermissionPrompt(
  props: PermissionPromptProps
): React.JSX.Element {
  const { request, onResolve } = props;

  const [selectedIndex, setSelectedIndex] = useState(0);
  const resolvedRef = useRef(false);

  const options = useMemo(
    () => [
      { value: "allow-once" as const, label: "允许一次", hint: "Y" },
      { value: "allow" as const, label: "总是允许", hint: "A" },
      { value: "deny" as const, label: "拒绝", hint: "N" },
    ],
    []
  );

  const resolve = useCallback(
    (choice: PermissionChoice) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onResolve(choice);
    },
    [onResolve]
  );

  useInput(
    (input, key) => {
      if (resolvedRef.current) return;

      if (input.startsWith("\x1b[") || input.startsWith("\x1b[M")) return;
      if (input.includes("\x1b[")) return;
      if (key.ctrl && input === "c") return;

      if (key.escape) {
        resolve("deny");
        return;
      }

      if (key.upArrow || key.leftArrow) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : options.length - 1));
        return;
      }
      if (key.downArrow || key.rightArrow) {
        setSelectedIndex((prev) => (prev < options.length - 1 ? prev + 1 : 0));
        return;
      }

      if (key.return) {
        resolve(options[selectedIndex]!.value);
        return;
      }

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

  const isDangerous =
    request.toolName === "run_command" ||
    request.toolName === "write_file" ||
    request.toolName === "search_replace";

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
    <Box flexDirection="column" marginY={1}>
      <Text bold color={isDangerous ? "red" : "yellow"}>
        {isDangerous ? "⚠️" : "→"} {toolNameCN} · {request.description.slice(0, 50)}
        {request.description.length > 50 ? "..." : ""}
      </Text>

      <Box flexDirection="row" gap={2}>
        {options.map((opt, idx) => {
          const isSelected = idx === selectedIndex;
          const color =
            opt.value === "deny" ? "red" : opt.value === "allow" ? "green" : "cyan";
          return (
            <Text key={opt.value} color={isSelected ? color : "gray"}>
              {isSelected ? "▸" : " "}
              {opt.label}
              <Text dimColor>({opt.hint})</Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
});
