// Story Outside — frontend controller (no build, no framework).
// Handles the multi-step "screen" navigation + a small set of demo API calls.

const SCREEN_ORDER = ["hero", "stories", "roles", "player", "chat", "done"];

const state = {
  demo: { mode: "demo", official_zhihu_api: false },
  stories: [],
  storyId: null,
  roleId: null,
  index: 0,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function setText(sel, text) {
  const el = $(sel);
  if (el) el.textContent = text;
}

function showScreen(name) {
  if (!SCREEN_ORDER.includes(name)) return;
  $$(".screen").forEach((s) => {
    const isActive = s.dataset.screen === name;
    s.classList.toggle("active", isActive);
    s.hidden = !isActive;
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
  const url = new URL(window.location.href);
  if (name === "hero") url.searchParams.delete("s");
  else url.searchParams.set("s", name);
  history.replaceState(null, "", url);
}

function showToast(message, ms = 2200) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = { error: "bad_json" };
  }
  if (!res.ok) {
    const e = new Error(data.error || `http_${res.status}`);
    e.data = data;
    throw e;
  }
  return data;
}

function applyDemoBanner(demo) {
  if (!demo) return;
  state.demo = demo;
  const tag = $("[data-mode-tag]");
  if (tag && demo.official_zhihu_api === false) {
    tag.textContent = `demo · ${demo.reason ? "未连接知乎官方 API" : "未连接知乎官方 API"}`;
    tag.title = demo.reason || "demo mode";
  }
  const meta = $("[data-demo-meta]");
  if (meta) {
    meta.textContent = demo.reason
      ? `> ${demo.reason}`
      : `> demo mode (no official API calls)`;
  }
}

async function loadStories() {
  const list = $("#story-list");
  if (list) {
    list.innerHTML = `<li class="placeholder">加载中…</li>`;
    list.setAttribute("aria-busy", "true");
  }
  try {
    const data = await api("/api/stories");
    applyDemoBanner(data.demo);
    state.stories = data.stories || [];
    renderStories();
  } catch (err) {
    if (list) {
      list.innerHTML = `<li class="placeholder">加载失败：${err.message}</li>`;
      list.setAttribute("aria-busy", "false");
    }
  }
}

function renderStories() {
  const list = $("#story-list");
  if (!list) return;
  list.setAttribute("aria-busy", "false");
  list.innerHTML = "";
  if (!state.stories.length) {
    list.innerHTML = `<li class="placeholder">暂无故事。</li>`;
    return;
  }
  state.stories.forEach((s) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "story-card";
    btn.type = "button";
    btn.dataset.storyId = s.id;
    btn.innerHTML = `
      <h3>${escapeHtml(s.title)}</h3>
      <p>${escapeHtml(s.hook)}</p>
    `;
    btn.addEventListener("click", () => selectStory(s.id));
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function selectStory(storyId) {
  state.storyId = storyId;
  state.roleId = null;
  state.index = 0;
  const story = state.stories.find((s) => s.id === storyId);
  if (!story) return;
  setText("#role-title", `${story.title} · 选一个角色`);
  setText("#role-hook", story.hook);
  const list = $("#role-list");
  if (list) {
    list.innerHTML = "";
    story.roles.forEach((r) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "role-card";
      btn.type = "button";
      btn.dataset.roleId = r.id;
      btn.innerHTML = `
        <h3>${escapeHtml(r.label)}</h3>
        <p class="mood">mood: ${escapeHtml(r.mood)}</p>
      `;
      btn.addEventListener("click", () => startPlayer(storyId, r.id));
      li.appendChild(btn);
      list.appendChild(li);
    });
  }
  showScreen("roles");
}

async function startPlayer(storyId, roleId) {
  state.storyId = storyId;
  state.roleId = roleId;
  state.index = 0;
  // Fetch the full story beats so the player can preview all upcoming beats.
  try {
    const data = await api(`/api/stories/${encodeURIComponent(storyId)}`);
    applyDemoBanner(data.demo);
    const story = data.story;
    if (!story) throw new Error("story_not_found");
    const role = story.roles.find((r) => r.id === roleId);
    setText("#player-title", story.title);
    setText(
      "#player-context",
      role ? `视角：${role.label} · ${role.mood}` : "视角：未选择"
    );
    renderBeats(story.beats, 0);
    showScreen("player");
  } catch (err) {
    showToast(`无法开始：${err.message}`);
  }
}

function renderBeats(beats, currentIndex) {
  const list = $("#beat-list");
  if (!list) return;
  list.innerHTML = "";
  beats.forEach((b, i) => {
    const li = document.createElement("li");
    li.className = "beat" + (i >= currentIndex ? " upcoming" : "");
    li.textContent = b;
    list.appendChild(li);
  });
}

async function advance() {
  const btn = $("#advance-btn");
  if (!btn) return;
  btn.disabled = true;
  try {
    const data = await api("/api/stories/advance", {
      method: "POST",
      body: JSON.stringify({
        storyId: state.storyId,
        roleId: state.roleId,
        index: state.index,
      }),
    });
    applyDemoBanner(data.demo);
    state.index = data.index;
    if (data.finished) {
      showToast("这一条线到这里");
      showScreen("done");
      return;
    }
    // Re-fetch full beats to refresh "upcoming" markers.
    const storyRes = await api(`/api/stories/${encodeURIComponent(state.storyId)}`);
    if (storyRes.story) renderBeats(storyRes.story.beats, state.index);
  } catch (err) {
    showToast(`推进失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function appendChat(role, text) {
  const log = $("#chat-log");
  if (!log) return;
  const li = document.createElement("li");
  li.className = `chat-msg ${role}`;
  li.textContent = text;
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}

async function sendChat(text) {
  appendChat("user", text);
  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    applyDemoBanner(data.demo);
    appendChat(
      "system",
      data.reply + (data.timestamp ? ` · ${formatTime(data.timestamp)}` : "")
    );
  } catch (err) {
    appendChat("system", `(error) ${err.message}`);
  }
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  } catch (err) {
    return "";
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function bindEvents() {
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const action = t.dataset.action;
    if (action === "goto") {
      showScreen(t.dataset.target || "hero");
    }
  });
  const advanceBtn = $("#advance-btn");
  if (advanceBtn) advanceBtn.addEventListener("click", advance);
  const chatForm = $("#chat-form");
  if (chatForm) {
    chatForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("#chat-input");
      const text = (input?.value || "").trim();
      if (!text) return;
      sendChat(text);
      if (input) input.value = "";
    });
  }
}

async function bootstrap() {
  bindEvents();
  try {
    const data = await api("/api/health");
    applyDemoBanner(data.demo);
  } catch (err) {
    showToast(`健康检查失败：${err.message}`);
  }
  // Restore screen from URL if present.
  const params = new URLSearchParams(window.location.search);
  const target = params.get("s");
  if (target && SCREEN_ORDER.includes(target) && target !== "hero") {
    if (target === "stories" || target === "chat") {
      // Stories + chat can be opened directly without a pick.
      showScreen(target);
      if (target === "stories") loadStories();
      if (target === "chat") {
        // Empty log on entry — placeholder flow.
        appendChat("system", "(demo 群聊已开启。输入一句话试试。)");
      }
      return;
    }
    showScreen("hero");
  } else {
    showScreen("hero");
  }
}

bootstrap();