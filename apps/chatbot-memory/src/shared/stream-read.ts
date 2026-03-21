/**
 * 浏览器与 Node（fetch Response.body）共用的 ReadableStream UTF-8 读取工具。
 */

/** 按块读取并解码；在 finally 中 releaseLock。适合再自行做 SSE 缓冲（如按 `\n\n` 切事件）。 */
export async function* readUtf8StreamChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        yield decoder.decode(value, { stream: true });
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

/** 按 `\n` 切行；流结束时输出末尾未闭合的一行。基于 readUtf8StreamChunks，避免重复 getReader 逻辑。 */
export async function* readUtf8Lines(stream: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!stream) {
    throw new Error("响应体为空");
  }
  let buffer = "";
  for await (const chunk of readUtf8StreamChunks(stream)) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      yield line;
    }
  }
  if (buffer.length > 0) {
    yield buffer;
  }
}
