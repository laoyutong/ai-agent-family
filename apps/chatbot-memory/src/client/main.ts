import "./style.css";
import { renderMarkdown } from "./markdown.js";
import { readUtf8StreamChunks } from "../shared/stream-read.js";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app missing");

const SESSION_KEY = "chatbot-memory-session";

function getSessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return "anonymous";
  }
}

const sessionId = getSessionId();

app.innerHTML = `
  <div class="shell">
    <aside class="sidebar" aria-label="对话导航">
      <div class="sidebar-title">话题</div>
      <nav class="question-list" id="question-list"></nav>
    </aside>
    <div class="layout">
      <header class="header">
        <h1>知忆</h1>
        <p class="sub">会话记忆 · 连贯上下文。侧栏可跳转至任意一轮；地址栏加 <code>#q-1</code>、<code>#a-1</code> 亦可直达</p>
      </header>
      <main class="chat" id="chat"></main>
    </div>
  </div>
`;

const composerWrap = document.createElement("div");
composerWrap.className = "composer-wrap";
composerWrap.innerHTML = `
  <div class="composer-align">
    <div class="composer-spacer" aria-hidden="true"></div>
    <footer class="composer" aria-label="消息输入">
      <button type="button" class="btn ghost" id="clear">清空记忆</button>
      <textarea id="input" rows="2" placeholder="向知忆发送消息 · Enter 发送，Shift+Enter 换行"></textarea>
      <button type="button" class="btn primary" id="send">发送</button>
    </footer>
  </div>
`;
document.body.appendChild(composerWrap);

const chatEl = app.querySelector<HTMLDivElement>("#chat")!;
const questionListEl = app.querySelector<HTMLDivElement>("#question-list")!;
const inputEl = composerWrap.querySelector<HTMLTextAreaElement>("#input")!;
const sendBtn = composerWrap.querySelector<HTMLButtonElement>("#send")!;
const clearBtn = composerWrap.querySelector<HTMLButtonElement>("#clear")!;

/** 当前轮次：每发一条用户问题 +1，用于 q-n / a-n 配对 */
let turnIndex = 0;

type AppendKind = "welcome" | "system";

function truncatePreview(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function renderIntroNav(): void {
  const a = document.createElement("a");
  a.href = "#chat-intro";
  a.className = "question-nav-item nav-intro";
  a.textContent = "开场";
  questionListEl.appendChild(a);
}

function addQuestionNavItem(n: number, text: string): void {
  const a = document.createElement("a");
  a.href = `#q-${n}`;
  a.className = "question-nav-item";
  a.textContent = `${n}. ${truncatePreview(text, 52)}`;
  a.title = text;
  questionListEl.appendChild(a);
}

function clearQuestionNav(): void {
  questionListEl.innerHTML = "";
}

function syncSidebarActive(): void {
  let hash = location.hash.slice(1);
  if (!hash) {
    for (const el of questionListEl.querySelectorAll("a.question-nav-item")) {
      el.classList.remove("is-active");
    }
    return;
  }
  try {
    hash = decodeURIComponent(hash);
  } catch {
    /* keep */
  }
  let activeHref = `#${hash}`;
  if (hash.startsWith("a-")) {
    activeHref = `#q-${hash.slice(2)}`;
  }
  for (const el of questionListEl.querySelectorAll("a.question-nav-item")) {
    const href = el.getAttribute("href");
    const on = href === activeHref || href === `#${hash}`;
    el.classList.toggle("is-active", on);
  }
}

function appendBubble(
  role: "user" | "assistant",
  text: string,
  options?: { kind?: AppendKind },
): void {
  const wrap = document.createElement("div");
  wrap.className = `bubble ${role}${role === "assistant" ? " markdown-body" : ""}`;
  if (role === "assistant") {
    wrap.innerHTML = renderMarkdown(text);
  } else {
    wrap.textContent = text;
  }

  if (role === "user") {
    turnIndex += 1;
    wrap.id = `q-${turnIndex}`;
    addQuestionNavItem(turnIndex, text);
  } else if (options?.kind === "welcome") {
    wrap.id = "chat-intro";
  } else if (options?.kind === "system") {
    wrap.id = `notice-${Date.now()}`;
  } else {
    wrap.id = `a-${turnIndex}`;
  }

  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
}

/** 创建空的助手气泡，用于流式追加文字（与刚发送的 q-n 对应） */
function createAssistantBubble(): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "bubble assistant markdown-body is-pending";
  wrap.setAttribute("aria-busy", "true");
  wrap.innerHTML = "";
  wrap.id = `a-${turnIndex}`;
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
  return wrap;
}

function clearAssistantPending(el: HTMLDivElement): void {
  el.classList.remove("is-pending");
  el.removeAttribute("aria-busy");
}

/** 根据地址栏 #q-1、#a-2、#chat-intro 等滚动到对应消息 */
function scrollToHashIfPresent(): void {
  const raw = location.hash.slice(1);
  if (!raw) return;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    /* keep raw */
  }
  const el = document.getElementById(id);
  if (el && chatEl.contains(el)) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  syncSidebarActive();
}

window.addEventListener("hashchange", () => {
  scrollToHashIfPresent();
});

function setAssistantMarkdown(el: HTMLDivElement, markdown: string): void {
  clearAssistantPending(el);
  el.innerHTML = renderMarkdown(markdown);
}

function scrollChat(): void {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setLoading(loading: boolean): void {
  sendBtn.disabled = loading;
  inputEl.disabled = loading;
}

function parseSseBlocks(buffer: string): { events: Record<string, unknown>[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: Record<string, unknown>[] = [];
  for (const block of parts) {
    const line = block.trim();
    if (!line.startsWith("data: ")) continue;
    try {
      events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
    } catch {
      /* ignore malformed line */
    }
  }
  return { events, rest };
}

async function send(): Promise<void> {
  const text = inputEl.value.trim();
  if (!text) return;
  appendBubble("user", text);
  inputEl.value = "";
  setLoading(true);

  const assistantEl = createAssistantBubble();
  let assistantMd = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Id": sessionId,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ message: text }),
    });

    if (!res.ok) {
      const errText = await res.text();
      let msg = res.statusText;
      try {
        const j = JSON.parse(errText) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        if (errText) msg = errText;
      }
      clearAssistantPending(assistantEl);
      assistantEl.textContent = `错误：${msg}`;
      return;
    }

    if (!res.body) {
      clearAssistantPending(assistantEl);
      assistantEl.textContent = "错误：无响应体";
      return;
    }

    let buffer = "";

    stream: for await (const chunk of readUtf8StreamChunks(res.body)) {
      buffer += chunk;
      const { events, rest } = parseSseBlocks(buffer);
      buffer = rest;

      for (const ev of events) {
        if (typeof ev.error === "string") {
          clearAssistantPending(assistantEl);
          assistantEl.textContent = `错误：${ev.error}`;
          return;
        }
        if (typeof ev.text === "string" && ev.text) {
          assistantMd += ev.text;
          setAssistantMarkdown(assistantEl, assistantMd);
          scrollChat();
        }
        if (ev.done === true) {
          break stream;
        }
      }
    }

    const { events: tailEvents } = parseSseBlocks(buffer + "\n\n");
    for (const ev of tailEvents) {
      if (typeof ev.error === "string") {
        clearAssistantPending(assistantEl);
        assistantEl.textContent = `错误：${ev.error}`;
        return;
      }
      if (typeof ev.text === "string" && ev.text) {
        assistantMd += ev.text;
        setAssistantMarkdown(assistantEl, assistantMd);
      }
    }

    if (assistantEl.classList.contains("is-pending")) {
      setAssistantMarkdown(assistantEl, assistantMd.trim() ? assistantMd : "（本次未收到内容）");
    }
  } catch (e) {
    clearAssistantPending(assistantEl);
    assistantEl.textContent = `网络错误：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    setLoading(false);
    inputEl.focus();
  }
}

sendBtn.addEventListener("click", () => void send());
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});

clearBtn.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/clear", {
      method: "POST",
      headers: { "X-Session-Id": sessionId },
    });
    if (!res.ok) throw new Error(await res.text());
    chatEl.innerHTML = "";
    turnIndex = 0;
    clearQuestionNav();
    appendBubble("assistant", "已清空本会话记忆，我们可以从头开始。", { kind: "system" });
  } catch (e) {
    appendBubble("assistant", `清空失败：${e instanceof Error ? e.message : String(e)}`, { kind: "system" });
  }
});

renderIntroNav();
appendBubble(
  "assistant",
  "你好，我是 **知忆**——你的记忆型对话伙伴。我会记住对话中的偏好与事实，让交流更连贯。从任意话题开始都可以。",
  { kind: "welcome" },
);

queueMicrotask(() => {
  scrollToHashIfPresent();
});
