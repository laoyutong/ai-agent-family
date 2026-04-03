/**
 * Node fetch Response.body：按 UTF-8 读流并切行（与 chatbot-memory shared/stream-read 对齐）。
 */
export async function* readUtf8StreamChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
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

export async function* readUtf8Lines(
  stream: ReadableStream<Uint8Array> | null,
): AsyncGenerator<string> {
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
