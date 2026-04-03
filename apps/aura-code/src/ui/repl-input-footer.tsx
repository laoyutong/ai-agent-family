import React, { memo, useState } from "react";
import { Box, Text } from "ink";
import { UncontrolledTextInput } from "ink-text-input";
import { theme } from "./theme.js";

export type ReplInputFooterProps = {
  onSubmitLine: (line: string) => void;
};

const ReplHints = memo(function ReplHints(): React.JSX.Element {
  return (
    <Box marginTop={0}>
      <Text dimColor>Enter · Ctrl+C · exit</Text>
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
    <Box flexDirection="column" marginTop={0} gap={0}>
      <Box flexDirection="row" alignItems="center" width="100%" paddingY={0}>
        <Box flexShrink={0}>
          <Text bold color={theme.user}>
            ●
          </Text>
        </Box>
        <Text> </Text>
        <Box flexGrow={1} flexShrink={1}>
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
      </Box>
      <ReplHints />
    </Box>
  );
});
