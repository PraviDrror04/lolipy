/* =========================================================
 * 萝莉Python · 主逻辑
 *  - CodeMirror 5.65.16（本地 vendor/，离线秒开，不白屏）
 *  - Pyodide 运行 Python（多 CDN 源自动降级）
 *  - DeepSeek API 助手（小码）
 * ========================================================= */

const $ = (id) => document.getElementById(id);

/* ---------- 安全存储层 ----------
 * file:// 页面下 localStorage 可能抛 SecurityError，
 * 一旦抛错会中断整段脚本导致白屏。这里做一层永不抛错的兜底。 */
const safeStore = (() => {
  try {
    const t = "__lolipy_t__";
    localStorage.setItem(t, "1");
    localStorage.removeItem(t);
    return {
      get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } },
      set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} },
    };
  } catch (_) {
    const mem = {};
    return {
      get: (k) => (k in mem ? mem[k] : null),
      set: (k, v) => { mem[k] = String(v); },
    };
  }
})();

/* ---------- 全局状态 ---------- */
const state = {
  cm: null,
  pyodide: null,
  running: false,
  stopRequested: false,
  aiHistory: [],
  cfg: {
    key: safeStore.get("lolipy_key") || "",
    base: safeStore.get("lolipy_base") || "https://api.deepseek.com",
    model: safeStore.get("lolipy_model") || "deepseek-chat",
  },
};

const DEFAULT_CODE = `# 欢迎来到 萝莉Python (๑•̀ㅂ•́)و✧
# 点右上角「▶ 运行」跑起来，点「✨ 小码」找 AI 帮忙

def greet(name):
    return f"你好呀，{name}～"

for n in ["主人", "世界"]:
    print(greet(n))

# 试试列表推导
squares = [x * x for x in range(6)]
print("平方数:", squares)
`;

const STORAGE_KEY_CODE = "lolipy_code";

/* ---------- 控制台输出 ---------- */
function log(text, cls = "") {
  const out = $("output");
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text + "\n";
  out.appendChild(span);
  out.scrollTop = out.scrollHeight;
}
function logSys(t) { log("· " + t, "sys"); }
function logOk(t)  { log("✔ " + t, "ok"); }
function logErr(t) { log("✘ " + t, "err"); }

/* ---------- CodeMirror 5 初始化（纯本地，同步可用） ---------- */
function initEditor() {
  if (typeof CodeMirror === "undefined") {
    logErr("编辑器内核未加载（vendor/codemirror.js 缺失）");
    return false;
  }

  const savedCode = safeStore.get(STORAGE_KEY_CODE);

  state.cm = CodeMirror($("editor"), {
    value: savedCode || DEFAULT_CODE,
    mode: { name: "python", version: 3, singleLineStringErrors: false },
    lineNumbers: true,
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    smartIndent: true,
    lineWrapping: false,
    styleActiveLine: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    theme: "lolipy",           // 自定义粉紫主题（见 style.css）
    extraKeys: {
      "Tab": (cm) => {
        if (cm.somethingSelected()) cm.indentSelection("add");
        else cm.replaceSelection("    ", "end");
      },
      "Shift-Tab": (cm) => cm.indentSelection("subtract"),
      "Ctrl-/": (cm) => cm.toggleComment(),
      "Cmd-/": (cm) => cm.toggleComment(),
    },
    placeholder: "# 在这里写 Python 吧～",
  });

  updateStatus();
  state.cm.on("cursorActivity", updateStatus);
  state.cm.on("change", () => {
    updateStatus();
    // 防抖保存草稿
    clearTimeout(state._saveTimer);
    state._saveTimer = setTimeout(() => {
      safeStore.set(STORAGE_KEY_CODE, state.cm.getValue());
    }, 500);
  });

  // 首次聚焦
  setTimeout(() => state.cm && state.cm.refresh(), 60);
  return true;
}

function getCode() { return state.cm ? state.cm.getValue() : ""; }
function setCode(text) { if (state.cm) state.cm.setValue(text); }
function updateStatus() {
  if (!state.cm) return;
  const cur = state.cm.getCursor();
  const len = state.cm.getValue().length;
  $("editor-status").textContent = `Python 3 · 第 ${cur.line + 1} 行 · ${len} 字符 ⭐`;
}

/* ---------- Pyodide 加载（多源降级） ---------- */
const PYODIDE_SOURCES = [
  "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/",
  "https://fastly.jsdelivr.net/pyodide/v0.26.2/full/",
  "https://unpkg.com/pyodide@0.26.2/",
  "https://cdnjs.cloudflare.com/ajax/libs/pyodide/0.26.2/",
];

function loadScript(src, timeoutMs = 10000) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    let settled = false;
    const done = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      s.remove();
      rej(new Error("加载超时: " + src));
    }, timeoutMs);
    s.src = src;
    s.onload = done(() => res());
    s.onerror = done(() => rej(new Error("加载失败: " + src)));
    document.head.appendChild(s);
  });
}

async function initPyodide() {
  const mask = $("py-loading");
  const maskText = $("py-loading-text");
  // 只在「运行」时打扰用户，且给出可跳过提示
  logSys("正在准备 Python 环境（首次需联网下载，请稍候）…");
  $("runtime-status").textContent = "Python 环境加载中…";
  if (mask) mask.classList.remove("hidden");

  let lastErr = null;
  for (const base of PYODIDE_SOURCES) {
    try {
      if (maskText) maskText.textContent = "小码正在准备 Python 环境…\n(" + new URL(base).host + ")";
      logSys("尝试源: " + new URL(base).host);
      await loadScript(base + "pyodide.js");
      state.pyodide = await window.loadPyodide({ indexURL: base });
      state.pyodide.setStdout({ batched: (s) => log(s) });
      state.pyodide.setStderr({ batched: (s) => log(s, "err") });
      $("runtime-status").textContent = "Python 3.12 就绪 ⭐";
      logOk("Python 环境已就绪！");
      if (mask) mask.classList.add("hidden");
      return true;
    } catch (e) {
      lastErr = e;
      logErr("该源不可用：" + e.message);
    }
  }

  $("runtime-status").textContent = "Python 环境加载失败";
  logErr("Python 环境加载失败：" + (lastErr ? lastErr.message : "未知错误"));
  logSys("（首次运行需要联网下载约 30MB 运行时，请确认网络可用后重试）");
  if (mask) mask.classList.add("hidden");
  return false;
}

/* 运行时未就绪时，按需加载后执行 */
async function ensurePyodide() {
  if (state.pyodide) return true;
  return await initPyodide();
}

async function runCode() {
  if (state.running) return;
  $("btn-run").disabled = true;
  const ok = await ensurePyodide();
  if (!ok) { $("btn-run").disabled = false; return; }

  const code = getCode();
  state.running = true; state.stopRequested = false;
  $("btn-stop").disabled = false;
  logSys("— 开始运行 —");
  const t0 = performance.now();
  try {
    await state.pyodide.runPythonAsync(code);
    const ms = (performance.now() - t0).toFixed(0);
    logOk(`运行结束，用时 ${ms} ms`);
    speak("跑好啦～");
  } catch (e) {
    logErr(String(e.message || e));
    speak("呜…出错惹");
  } finally {
    state.running = false;
    $("btn-run").disabled = false; $("btn-stop").disabled = true;
  }
}

function stopCode() {
  if (!state.running) return;
  state.stopRequested = true;
  logSys("（Pyodide 不支持中断正在执行的同步代码，请等待当前代码结束）");
}

/* ---------- 语音（Web Speech，可选） ---------- */
function speak(text) {
  try {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN"; u.pitch = 1.6; u.rate = 1.05; u.volume = 0.9;
    window.speechSynthesis.speak(u);
  } catch (_) {}
}

/* ---------- DeepSeek API ---------- */
const SYSTEM_PROMPT =
  "你是「小码」，一个可爱的二次元萝莉编程助手，说话俏皮但技术靠谱。" +
  "用户在用手机写 Python。回答尽量简洁，代码用 markdown 代码块。";

async function callDeepSeek(messages, onDelta) {
  if (!state.cfg.key) {
    throw new Error("还没配置 API Key，点「⚙ API 设置」填一下～");
  }
  const url = state.cfg.base.replace(/\/$/, "") + "/v1/chat/completions";
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + state.cfg.key,
    },
    body: JSON.stringify({
      model: state.cfg.model,
      messages,
      stream: true,
      temperature: 0.6,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`API ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const data = s.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch (_) {}
    }
  }
}

/* ---------- AI 抽屉 UI ---------- */
function aiAdd(role, text) {
  const logEl = $("ai-log");
  const div = document.createElement("div");
  div.className = "msg " + (role === "user" ? "user" : "bot");
  div.innerHTML = renderMarkdown(text);
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  return div;
}

function renderMarkdown(t) {
  const esc = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.replace(/\n$/, "")}</code></pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

async function askAI(userText, systemExtra = "") {
  aiAdd("user", userText);
  const botEl = aiAdd("bot", "…");
  const msgs = [
    { role: "system", content: SYSTEM_PROMPT + (systemExtra ? "\n" + systemExtra : "") },
    ...state.aiHistory.slice(-8),
    { role: "user", content: userText },
  ];
  let acc = "";
  try {
    await callDeepSeek(msgs, (delta) => {
      acc += delta;
      botEl.innerHTML = renderMarkdown(acc);
      $("ai-log").scrollTop = $("ai-log").scrollHeight;
    });
    state.aiHistory.push({ role: "user", content: userText });
    state.aiHistory.push({ role: "assistant", content: acc });
  } catch (e) {
    botEl.innerHTML = renderMarkdown("呜…出错了：" + e.message);
  }
}

/* ---------- 工具按钮 ---------- */
function getSelectionText() {
  if (!state.cm) return "";
  return state.cm.getSelection();
}

const TOOL_PROMPTS = {
  explain: (code) => `请用中文解释这段 Python 代码在做什么，简明扼要：\n\`\`\`python\n${code}\n\`\`\``,
  fix: () => `我的 Python 代码报错了，请帮我分析原因并给出修正后的代码。\n\n当前代码：\n\`\`\`python\n${getCode()}\n\`\`\`\n\n最近的控制台输出：\n\`\`\`\n${$("output").textContent.slice(-1200)}\n\`\`\``,
  gen: () => {
    const ask = prompt("想让小码写什么代码？", "读取一个列表并打印其中所有偶数");
    return ask ? `请写一段 Python 代码：${ask}。只给代码和简短说明。` : null;
  },
  comment: (code) => `请给这段代码加上清晰的中文注释，直接返回带注释的完整代码：\n\`\`\`python\n${code || getCode()}\n\`\`\``,
};

/* ---------- 事件绑定 ---------- */
function bindUI() {
  $("btn-run").onclick = runCode;
  $("btn-stop").onclick = stopCode;
  $("btn-clear").onclick = () => { $("output").textContent = ""; };
  $("btn-theme").onclick = () => {
    document.body.classList.toggle("dark");
    safeStore.set("lolipy_dark", document.body.classList.contains("dark") ? "1" : "0");
  };

  $("btn-ai").onclick = () => $("ai-drawer").classList.remove("hidden");
  $("btn-ai-close").onclick = () => $("ai-drawer").classList.add("hidden");

  $("btn-ai-send").onclick = () => {
    const v = $("ai-input").value.trim();
    if (!v) return;
    $("ai-input").value = "";
    askAI(v + "\n\n（当前编辑器代码：\n```python\n" + getCode().slice(0, 2000) + "\n```）");
  };
  $("ai-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-ai-send").click();
  });

  document.querySelectorAll(".tool").forEach((btn) => {
    btn.onclick = () => {
      const t = btn.dataset.tool;
      if (t === "settings") return openSettings();
      const code = getSelectionText();
      const fn = TOOL_PROMPTS[t];
      if (!fn) return;
      const promptText = fn(code);
      if (promptText) askAI(promptText, "当前编辑器完整代码：\n```python\n" + getCode().slice(0, 3000) + "\n```");
    };
  });

  $("btn-cancel").onclick = () => $("settings-modal").classList.add("hidden");
  $("btn-save").onclick = saveSettings;

  // 有屏幕变化时刷新编辑器尺寸
  window.addEventListener("resize", () => state.cm && state.cm.refresh());
  window.addEventListener("orientationchange", () => setTimeout(() => state.cm && state.cm.refresh(), 200));
}

function openSettings() {
  $("in-key").value = state.cfg.key;
  $("in-base").value = state.cfg.base;
  $("in-model").value = state.cfg.model;
  $("settings-modal").classList.remove("hidden");
}
function saveSettings() {
  state.cfg.key = $("in-key").value.trim();
  state.cfg.base = $("in-base").value.trim() || "https://api.deepseek.com";
  state.cfg.model = $("in-model").value;
  safeStore.set("lolipy_key", state.cfg.key);
  safeStore.set("lolipy_base", state.cfg.base);
  safeStore.set("lolipy_model", state.cfg.model);
  $("settings-modal").classList.add("hidden");
  logOk("API 设置已保存（仅存本机）");
}

/* ---------- 返回键钩子（供原生 BackHandler 调用） ---------- */
window.__lolipyBack = function () {
  const drawer = $("ai-drawer");
  const modal = $("settings-modal");
  if (modal && !modal.classList.contains("hidden")) { modal.classList.add("hidden"); return; }
  if (drawer && !drawer.classList.contains("hidden")) { drawer.classList.add("hidden"); return; }
  if (window.AndroidBridge && AndroidBridge.toast) {
    AndroidBridge.toast("再按一次返回键退出哦～");
  }
};

/* ---------- 启动 ---------- */
(function boot() {
  if (safeStore.get("lolipy_dark") === "1") document.body.classList.add("dark");
  document.body.classList.remove("loading-mode");
  bindUI();

  const ok = initEditor();
  if (ok) {
    logOk("编辑器已就绪（离线内核）");
  } else {
    // 极端兜底：即便 CodeMirror 没加载出来，也用原生 textarea 顶上
    const ta = document.createElement("textarea");
    ta.id = "editor-fallback";
    ta.value = safeStore.get(STORAGE_KEY_CODE) || DEFAULT_CODE;
    ta.style.cssText = "width:100%;height:100%;border:none;outline:none;padding:10px;font-family:monospace;font-size:14px;background:transparent;color:var(--ink);resize:none;";
    $("editor").appendChild(ta);
    logSys("已启用备用编辑器（textarea）");
  }

  // Pyodide 改为「按需加载」：启动时不联网下载运行时，
  // 只在用户点击「▶ 运行」时才通过 ensurePyodide() 触发，
  // 避免打开应用即弹出近白遮罩、国内 CDN 卡死导致的“白屏”。
})();
