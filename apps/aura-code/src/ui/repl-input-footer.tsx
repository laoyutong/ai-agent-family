import React, { memo, useState } from "react";
import { Box, Text } from "ink";
import { UncontrolledTextInput } from "ink-text-input";
import { theme } from "./theme.js";

export type ReplInputFooterProps = {
  onSubmitLine: (line: string) => void;
};

/** 顶部分隔线：无 props；只在挂载时算宽度 */
const ReplRuleLine = memo(function ReplRuleLine(): React.JSX.Element {
  const rule = "─".repeat(
    Math.max(16, Math.min(64, (process.stdout.columns ?? 48) - 4)),
  );
  return <Text dimColor>{rule}</Text>;
});

/** 底部快捷键说明 */
const ReplHints = memo(function ReplHints(): React.JSX.Element {
  return (
    <Box marginTop={0} paddingX={1}>
      <Text dimColor>Enter 发送</Text>
      <Text dimColor> · </Text>
      <Text dimColor>Ctrl+C 中断或退出</Text>
      <Text dimColor> · </Text>
      <Text dimColor>exit</Text>
    </Box>
  );
});

/**
 * UncontrolledTextInput：输入值只存在子组件内，每键不重绘父级与整块 ChatApp。
 * Enter 后递增 key 以清空输入行。
 */
export const ReplInputFooter = memo(function ReplInputFooter({
  onSubmitLine,
}: ReplInputFooterProps): React.JSX.Element {
  const [lineKey, setLineKey] = useState(0);

  return (
    <Box flexDirection="column" marginTop={0}>
      <ReplRuleLine />
      <Box
        flexDirection="row"
        alignItems="center"
        paddingX={1}
        borderStyle="round"
        borderColor={theme.borderFocus}
      >
        <Text bold color={theme.prompt}>
          ›{" "}
        </Text>
        <UncontrolledTextInput
          key={lineKey}
          initialValue=""
          placeholder="有问题尽管问…"
          focus
          onSubmit={(value) => {
            onSubmitLine(value);
            setLineKey((k) => k + 1);
          }}
        />
      </Box>
      <ReplHints />
    </Box>
  );
});
