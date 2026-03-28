/**
 * 服务端对 `src/shared` 的统一再导出，子目录模块可始终使用 `../shared/index.js` 引用。
 */
export type { ChatStreamPart, ChatStreamPhase } from "../../shared/chat-stream.js";
export { phaseLabel } from "../../shared/chat-stream.js";
export { readUtf8Lines } from "../../shared/stream-read.js";
