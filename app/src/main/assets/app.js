/* =========================================================
 * 萝莉Python · 主逻辑
 *  - CodeMirror 6 编辑器（ESM 动态加载）
 *  - Pyodide 运行 Python
 *  - DeepSeek API 助手（小码）
 * ========================================================= */

const $ = (id) => document.getElementById(id);

/* ---------- 全局状态 ---------- */
const state = {
  cm: null,
  pyodide: null,
  running: false,
  stopRequested: false,
  aiHistory: [],
  cfg: {
    key: localStorage.getItem("lolipy_key") || "",
    base: localStorage.getItem("lolipy_base") || "https://api.deepseek.com",
    model: localStorage.getItem("lolipy_model") || "deepseek-chat",
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

/* ---------- CodeMirror 初始化 ---------- */
async function initEditor() {
  const [{ EditorState, Compartment }, { EditorView, keymap, lineNumbers,
           highlightActiveLine, highlightActiveLineGutter, drawSelection,
           dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars },
         { defaultKeymap, history, historyKeymap, indentWithTab },
         { python },
         { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput, foldGutter, foldKeymap },
         { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap }] =
    await Promise.all([
      import("https://esm.sh/@codemirror/state@6"),
      import("https://esm.sh/@codemirror/view@6"),
      import("https://esm.sh/@codemirror/commands@6"),
      import("https://esm.sh/@codemirror/lang-python@6"),
      import("https://esm.sh/@codemirror/language@6"),
      import("https://esm.sh/@codemirror/autocomplete@6"),
    ]);

  const theme = EditorView.theme({
    "&": { backgroundColor: "transparent", color: "var(--ink)" },
    ".cm-content": { caretColor: "var(--pink-3)", padding: "8px 0" },
    ".cm-gutters": { backgroundColor: "transparent", color: "var(--ink-soft)", border: "none" },
    ".cm-activeLine": { backgroundColor: "rgba(255,154,197,.10)" },
    ".cm-activeLineGutter": { backgroundColor: "rgba(255,154,197,.14)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "rgba(183,156,255,.28) !important"
    },
    ".cm-cursor": { borderLeftColor: "var(--pink-3)", borderLeftWidth: "2px" },
  }, { dark: false });

  const startState = EditorState.create({
    doc: DEFAULT_CODE,
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(),
      history(), foldGutter(), drawSelection(), dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(), closeBrackets(), autocompletion(), rectangularSelection(),
      crosshairCursor(), highlightActiveLine(),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap,
                 ...foldKeymap, ...completionKeymap, indentWithTab]),
      python(), theme,
    ],
  });

  state.cm = new EditorView({ state: startState, parent: $("editor") });
  updateStatus();
  state.cm.dom.addEventListener("keyup", updateStatus);
  state.cm.dom.addEventListener("click", updateStatus);
}

function getCode() { return state.cm.state.doc.toString(); }
function setCode(text) {
  state.cm.dispatch({
    changes: { from: 0, to: state.cm.state.doc.length, insert: text }
  });
}
function updateStatus() {
  const doc = state.cm.state.doc;
  const sel = state.cm.state.selection.main;
  const line = doc.lineAt(sel.head).number;
  $("editor-status").textContent = `Python 3 · 第 ${line} 行 · ${doc.length} 字符 ⭐`;
}

/* ---------- Pyodide 加载与运行 ---------- */
async function initPyodide() {
  $("loading").classList.remove("hidden");
  logSys("正在加载 Pyodide (Python 3 WASM)…");
  try {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js";
    document.head.appendChild(script);
    await new Promise((res, rej) => { script.onload = res; script.onerror = rej; });

    state.pyodide = await window.loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/"
    });
    // 把 print/错误 输出接到控制台
    state.pyodide.setStdout({ batched: (s) => log(s) });
    state.pyodide.setStderr({ batched: (s) => log(s, "err") });
    $("runtime-status").textContent = "Pyodide 就绪 · Python 3.12 ⭐";
    logOk("Python 环境已就绪！");
  } catch (e) {
    $("runtime-status").textContent = "Pyodide 加载失败";
    logErr("Python 环境加载失败：" + e.message);
    logSys("（首次运行需要联网下载运行时，请确认网络可用）");
  } finally {
    $("loading").classList.add("hidden");
  }
}

async function runCode() {
  if (state.running) return;
  if (!state.pyodide) { logErr("Python 环境尚未就绪，请稍候…"); return; }
  const code = getCode();
  state.running = true; state.stopRequested = false;
  $("btn-run").disabled = true; $("btn-stop").disabled = false;
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

/* ---------- 工具按钮：把选中内容发给 AI ---------- */
function getSelectionText() {
  const sel = state.cm.state.selection.main;
  return state.cm.state.sliceDoc(sel.from, sel.to);
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
    localStorage.setItem("lolipy_dark", document.body.classList.contains("dark") ? "1" : "0");
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

  // 设置弹窗
  $("btn-cancel").onclick = () => $("settings-modal").classList.add("hidden");
  $("btn-save").onclick = saveSettings;
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
  localStorage.setItem("lolipy_key", state.cfg.key);
  localStorage.setItem("lolipy_base", state.cfg.base);
  localStorage.setItem("lolipy_model", state.cfg.model);
  $("settings-modal").classList.add("hidden");
  logOk("API 设置已保存（仅存本机）");
}

/* ---------- 返回键钩子（供原生 BackHandler 调用） ---------- */
window.__lolipyBack = function () {
  const drawer = $("ai-drawer");
  const modal = $("settings-modal");
  if (modal && !modal.classList.contains("hidden")) { modal.classList.add("hidden"); return; }
  if (drawer && !drawer.classList.contains("hidden")) { drawer.classList.add("hidden"); return; }
  // 都不开着时，交给系统处理（原生侧可选择退出）
  if (window.AndroidBridge && AndroidBridge.toast) {
    AndroidBridge.toast("再按一次返回键退出哦～");
  }
};

/* ---------- 启动 ---------- */
(async function boot() {
  if (localStorage.getItem("lolipy_dark") === "1") document.body.classList.add("dark");
  bindUI();
  try {
    await initEditor();
  } catch (e) {
    logErr("编辑器初始化失败（需联网加载 CodeMirror）：" + e.message);
  }
  initPyodide();
})();