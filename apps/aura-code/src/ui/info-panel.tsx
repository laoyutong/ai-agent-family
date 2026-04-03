import React from "react";
import { Box, Text } from "ink";
import { MascotCatLines } from "./mascot-cat.js";
import { shortenPath, theme } from "./theme.js";

export type InfoPanelProps = {
  model: string;
  cwd: string;
};

/**
 * 启动信息总览：小猫、CLI、模型、目录 —— 同一圆角框内，尽量紧凑。
 */
export function InfoPanel({ model, cwd }: InfoPanelProps): React.JSX.Element {
  const cwdDisplay = shortenPath(cwd);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={0}
      paddingY={0}
      marginBottom={0}
      gap={0}
    >
      <MascotCatLines />

      <Box flexDirection="column" gap={0} marginTop={0}>
        <Box flexDirection="row" flexWrap="wrap">
          <Text dimColor>CLI </Text>
          <Text bold color={theme.title}>
            Aura
          </Text>
          <Text> </Text>
          <Text bold color={theme.brand}>
            Code
          </Text>
          <Text dimColor> · </Text>
          <Text dimColor>模型 </Text>
          <Text bold color={theme.userMuted}>
            {model}
          </Text>
        </Box>

        <Box flexDirection="row" flexWrap="wrap">
          <Text dimColor>目录 </Text>
          <Text wrap="wrap">{cwdDisplay}</Text>
        </Box>
      </Box>
    </Box>
  );
}
