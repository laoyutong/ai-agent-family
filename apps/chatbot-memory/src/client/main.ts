import "./style.css";
import { renderMarkdown } from "./markdown.js";
import { readUtf8StreamChunks } from "../shared/stream-read.js";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app missing");

/** 当前选中的会话 id（与 X-Session-Id 一致） */
let currentSessionId = "";

const ACTIVE_SESSION_KEY = "chatbot-memory-active-session";
const LEGACY_SESSION_KEY = "chatbot-memory-session";

const WELCOME_TEXT =
  "你好，我是 **知忆**——你的记忆型对话伙伴。我会记住对话中的偏好与事实，让交流更连贯。从任意话题开始都可以。";

type SessionMeta = { id: string; title: string; updatedAt: number };

function migrateLegacySessionId(): void {
  try {
    const hasActive = localStorage.getItem(ACTIVE_SESSION_KEY);
    const legacy = sessionStorage.getItem(LEGACY_SESSION_KEY);
    if (!hasActive && legacy) {
      localStorage.setItem(ACTIVE_SESSION_KEY, legacy);
      sessionStorage.removeItem(LEGACY_SESSION_KEY);
    }
  } catch {
    /* private mode */
  }
}

app.innerHTML = `
  <div class="shell">
    <aside class="sidebar" aria-label="会话与话题">
      <div class="sidebar-title">会话</div>
      <div class="session-toolbar">
        <button type="button" class="btn ghost session-new-btn" id="new-session">新会话</button>
      </div>
      <nav class="session-list" id="session-list" aria-label="会话列表"></nav>
      <div class="sidebar-title sidebar-title-topic">话题</div>
      <nav class="question-list" id="question-list"></nav>
    </aside>
    <div class="layout">
      <header class="header">
        <h1>知忆</h1>
        <p class="sub">多会话持久化至本机 · 侧栏切换会话；话题可跳转至任意一轮；地址栏 <code>#q-1</code>、<code>#a-1</code></p>
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
const sessionListEl = app.querySelector<HTMLDivElement>("#session-list")!;
const questionListEl = app.querySelector<HTMLDivElement>("#question-list")!;
const inputEl = composerWrap.querySelector<HTMLTextAreaElement>("#input")!;
const sendBtn = composerWrap.querySelector<HTMLButtonElement>("#send")!;
const clearBtn = composerWrap.querySelector<HTMLButtonElement>("#clear")!;
const newSessionBtn = app.querySelector<HTMLButtonElement>("#new-session")!;

/** 当前轮次：每发一条用户问题 +1，用于 q-n / a-n 配对 */
let turnIndex = 0;

type AppendKind = "welcome" | "system";

function previewLabel(s: string): string {
  return s.trim().replace(/\s+/g, " ");
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
  a.textContent = `${n}. ${previewLabel(text)}`;
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

async function fetchSessionList(): Promise<SessionMeta[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(await res.text());
  const data = (await res.json()) as { sessions?: SessionMeta[] };
  return data.sessions ?? [];
}

function renderSessionList(sessions: SessionMeta[]): void {
  sessionListEl.innerHTML = "";
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "session-row";
    if (s.id === currentSessionId) row.classList.add("is-active");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "session-item";
    btn.textContent = previewLabel(s.title);
    btn.title = s.title;
    btn.addEventListener("click", () => {
      void switchToSession(s.id);
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "session-delete";
    del.setAttribute("aria-label", "删除会话");
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      void deleteSessionById(s.id);
    });

    row.appendChild(btn);
    row.appendChild(del);
    sessionListEl.appendChild(row);
  }
}

async function refreshSessionList(): Promise<void> {
  try {
    const sessions = await fetchSessionList();
    renderSessionList(sessions);
  } catch {
    /* ignore */
  }
}

async function hydrateSession(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
  if (res.status === 404) {
    const cr = await fetch("/api/sessions", { method: "POST" });
    if (!cr.ok) throw new Error(await cr.text());
    const { id: nid } = (await cr.json()) as { id: string };
    currentSessionId = nid;
    try {
      localStorage.setItem(ACTIVE_SESSION_KEY, nid);
    } catch {
      /* */
    }
    await hydrateSession(nid);
    return;
  }
  if (!res.ok) throw new Error(await res.text());

  const payload = (await res.json()) as {
    turns: Array<{ role: string; content: string }>;
  };

  chatEl.innerHTML = "";
  turnIndex = 0;
  clearQuestionNav();
  renderIntroNav();

  const turns = payload.turns;
  for (let i = 0; i < turns.length; i += 2) {
    const u = turns[i];
    const a = turns[i + 1];
    if (u?.role === "user" && a?.role === "assistant") {
      appendBubble("user", u.content);
      appendBubble("assistant", a.content);
    } else if (u?.role === "user") {
      appendBubble("user", u.content);
    }
  }

  if (turns.length === 0) {
    appendBubble("assistant", WELCOME_TEXT, { kind: "welcome" });
  }

  queueMicrotask(() => {
    scrollToHashIfPresent();
  });
}

async function switchToSession(id: string): Promise<void> {
  if (id === currentSessionId) return;
  currentSessionId = id;
  try {
    localStorage.setItem(ACTIVE_SESSION_KEY, id);
  } catch {
    /* */
  }
  await hydrateSession(id);
  await refreshSessionList();
}

async function deleteSessionById(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) return;

  const sessions = await fetchSessionList();
  if (id !== currentSessionId) {
    await refreshSessionList();
    return;
  }

  if (sessions.length === 0) {
    const cr = await fetch("/api/sessions", { method: "POST" });
    const { id: nid } = (await cr.json()) as { id: string };
    currentSessionId = nid;
    try {
      localStorage.setItem(ACTIVE_SESSION_KEY, nid);
    } catch {
      /* */
    }
    await hydrateSession(nid);
  } else {
    const next = sessions[0].id;
    currentSessionId = next;
    try {
      localStorage.setItem(ACTIVE_SESSION_KEY, next);
    } catch {
      /* */
    }
    await hydrateSession(next);
  }
  await refreshSessionList();
}

async function createNewSession(): Promise<void> {
  const res = await fetch("/api/sessions", { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  const { id } = (await res.json()) as { id: string };
  currentSessionId = id;
  try {
    localStorage.setItem(ACTIVE_SESSION_KEY, id);
  } catch {
    /* */
  }
  await hydrateSession(id);
  await refreshSessionList();
}

async function resolveInitialSession(): Promise<void> {
  migrateLegacySessionId();

  let sessions = await fetchSessionList();

  let preferred = "";
  try {
    preferred = localStorage.getItem(ACTIVE_SESSION_KEY) ?? "";
  } catch {
    /* */
  }

  const ids = new Set(sessions.map((s) => s.id));

  if (sessions.length === 0) {
    const cr = await fetch("/api/sessions", { method: "POST" });
    if (!cr.ok) throw new Error(await cr.text());
    const { id } = (await cr.json()) as { id: string };
    currentSessionId = id;
    try {
      localStorage.setItem(ACTIVE_SESSION_KEY, id);
    } catch {
      /* */
    }
    await hydrateSession(id);
    await refreshSessionList();
    return;
  }

  if (preferred && ids.has(preferred)) {
    currentSessionId = preferred;
  } else {
    currentSessionId = sessions[0].id;
    try {
      localStorage.setItem(ACTIVE_SESSION_KEY, currentSessionId);
    } catch {
      /* */
    }
  }

  await hydrateSession(currentSessionId);
  sessions = await fetchSessionList();
  renderSessionList(sessions);
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
        "X-Session-Id": currentSessionId,
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

    void refreshSessionList();
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
  if (e.key !== "Enter" || e.shiftKey) return;
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  void send();
});

clearBtn.addEventListener("click", async () => {
  try {
    const res = await fetch("/api/clear", {
      method: "POST",
      headers: { "X-Session-Id": currentSessionId },
    });
    if (!res.ok) throw new Error(await res.text());
    chatEl.innerHTML = "";
    turnIndex = 0;
    clearQuestionNav();
    renderIntroNav();
    appendBubble("assistant", "已清空本会话记忆，我们可以从头开始。", { kind: "system" });
    void refreshSessionList();
  } catch (e) {
    appendBubble("assistant", `清空失败：${e instanceof Error ? e.message : String(e)}`, { kind: "system" });
  }
});

newSessionBtn.addEventListener("click", () => void createNewSession());

async function bootstrap(): Promise<void> {
  sendBtn.disabled = true;
  clearBtn.disabled = true;
  newSessionBtn.disabled = true;
  try {
    await resolveInitialSession();
  } catch (e) {
    appendBubble(
      "assistant",
      `初始化失败：${e instanceof Error ? e.message : String(e)}。请确认已启动服务并配置 DEEPSEEK_API_KEY。`,
      { kind: "system" },
    );
  } finally {
    sendBtn.disabled = false;
    clearBtn.disabled = false;
    newSessionBtn.disabled = false;
  }
}

void bootstrap();
