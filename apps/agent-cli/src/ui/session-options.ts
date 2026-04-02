export const DEFAULT_SYSTEM =
  "You are a concise, helpful coding assistant running in the terminal.";

export type ReplOptions = {
  chatUrl: string;
  apiKey: string;
  model: string;
  cwd?: string;
  systemPrompt?: string;
};

export function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err
    ? (err as { name: string }).name === "AbortError"
    : false;
}
