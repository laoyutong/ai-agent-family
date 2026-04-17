import React, { memo } from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

/** 紧凑 ASCII 小猫（3 行） */
export const MASCOT_CAT_LINES = [
  "  /\\_/\\  ",
  " ( · · ) ",
  "  ～ 喵 ～ ",
] as const;

export const MascotCatLines = memo(function MascotCatLines(): React.JSX.Element {
  return (
    <Box flexDirection="column" alignItems="flex-start" marginBottom={0}>
      {MASCOT_CAT_LINES.map((line, i) => (
        <Text key={i} dimColor color={theme.brand}>
          {line}
        </Text>
      ))}
    </Box>
  );
});
