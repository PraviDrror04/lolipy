/* 萝莉Python 主逻辑 —— CodeMirror 编辑器 + Pyodide 运行 + AI 辅助 + 文件导入导出 */
(function () {
  'use strict';

  // ---------- 常量 ----------
  var API_KEY_KEY = 'lolipy.api.key';
  var API_BASE_KEY = 'lolipy.api.base';
  var API_MODEL_KEY = 'lolipy.api.model';
  var THEME_KEY = 'lolipy.theme';

  var PYODIDE_VERSION = 'v0.26.4';
  var PYODIDE_JS = 'https://cdn.jsdelivr.net/pyodide/' + PYODIDE_VERSION + '/full/pyodide.js';
  var PYODIDE_INDEX = 'https://cdn.jsdelivr.net/pyodide/' + PYODIDE_VERSION + '/full/';

  var DEFAULT_CODE =
    '# 欢迎使用 萝莉Python ✨\n' +
    '# 这里可以编写并运行 Python 代码\n' +
    'print("Hello, 萝莉Python!")\n\n' +
    'for i in range(5):\n' +
    '    print("第", i + 1, "次运行")\n';

  // ---------- 状态 ----------
  var editor = null;
  var pyodide = null;
  var pyLoading = false;
  var currentFileName = 'script.py';

  function el(id) { return document.getElementById(id); }

  // ---------- 主题 ----------
  function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme);
  }
  function loadTheme() {
    applyTheme(localStorage.getItem(THEME_KEY) || 'light');
  }
  function toggleTheme() {
    var next = (document.body.getAttribute('data-theme') === 'dark') ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  }

  // ---------- 轻提示 ----------
  function toast(msg) {
    if (window.NativeBridge && window.NativeBridge.toast) {
      try { window.NativeBridge.toast(msg); return; } catch (e) {}
    }
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2000);
  }

  // ---------- 编辑器 ----------
  function initEditor() {
    editor = CodeMirror(el('editor'), {
      value: DEFAULT_CODE,
      mode: 'python',
      theme: 'default',
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      lineWrapping: false,
      styleActiveLine: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      placeholder: '# 在这里写 Python 代码…'
    });
    editor.on('change', updateStatus);
    editor.on('cursorActivity', updateStatus);
    updateStatus();
  }

  function updateStatus() {
    var c = editor.getCursor();
    el('editor-status').textContent =
      'Python 3 · 第 ' + (c.line + 1) + ' 行 / 共 ' + editor.lineCount() +
      ' 行 · ' + currentFileName;
  }

  // ---------- 输出 ----------
  function appendOut(s) {
    var pre = el('output');
    pre.textContent += s;
    pre.scrollTop = pre.scrollHeight;
  }

  // ---------- input() 支持 ----------
  // Pyodide 同步执行不支持交互式 stdin，这里用 window.prompt()（原生层
  // onJsPrompt 已接入 AlertDialog）替换内置 input()，让 input() 能弹框等待输入。
  function installInputShim(py) {
    try {
      py.runPython(
        'import builtins\n' +
        'import sys\n' +
        'from js import prompt as _js_prompt\n' +
        'def _loli_input(p=""):\n' +
        '    try:\n' +
        '        sys.stdout.write(str(p))\n' +
        '        sys.stdout.flush()\n' +
        '    except Exception:\n' +
        '        pass\n' +
        '    s = _js_prompt(str(p))\n' +
        '    return "" if s is None else str(s)\n' +
        'builtins.input = _loli_input\n'
      );
    } catch (e) {
      console.log('installInputShim failed: ' + (e && e.message ? e.message : e));
    }
  }

  // ---------- 运行 Python ----------
  function runCode() {
    var code = editor.getValue();
    if (!code.trim()) { appendOut('(没有可运行的代码)\n'); return; }
    el('btn-run').disabled = true;
    el('btn-stop').disabled = false;
    ensurePyodide(
      function (py) {
        appendOut('>>> 运行中…\n');
        try {
          py.setStdout({ batched: function (s) { appendOut(s); } });
          py.setStderr({ batched: function (s) { appendOut(s); } });
          installInputShim(py);
          var r = py.runPython(code);
          if (r !== undefined && r !== null) appendOut(String(r) + '\n');
          appendOut('\n>>> 运行结束\n');
        } catch (err) {
          appendOut('\n⚠️ 运行错误：' + (err && err.message ? err.message : err) + '\n');
        }
        el('btn-run').disabled = false;
        el('btn-stop').disabled = true;
      },
      function (err) {
        appendOut('\n⚠️ Python 环境加载失败：' + err + '\n');
        el('btn-run').disabled = false;
        el('btn-stop').disabled = true;
      }
    );
  }

  function stopCode() {
    // 同步运行的 Pyodide 无法被真正中断，这里做状态复位
    el('btn-run').disabled = false;
    el('btn-stop').disabled = true;
    appendOut('\n(已停止 / 复位)\n');
  }

  function showPyLoading(show, text) {
    if (text) el('py-loading-text').textContent = text;
    var d = el('py-loading');
    if (show) d.classList.remove('hidden'); else d.classList.add('hidden');
  }

  function ensurePyodide(onOk, onErr) {
    if (pyodide) { onOk(pyodide); return; }
    if (pyLoading) { appendOut('(Python 环境加载中，请稍候…)\n'); return; }
    pyLoading = true;
    showPyLoading(true, '小码正在准备 Python 环境（首次需联网下载，约 10~20MB）…');

    function doLoad() {
      window.loadPyodide({ indexURL: PYODIDE_INDEX })
        .then(function (py) {
          pyodide = py;
          pyLoading = false;
          showPyLoading(false);
          el('runtime-status').textContent = 'Python 3（Pyodide）已就绪';
          onOk(py);
        })
        .catch(function (e) {
          pyLoading = false;
          showPyLoading(false);
          onErr(e && e.message ? e.message : e);
        });
    }

    if (window.loadPyodide) {
      doLoad();
    } else {
      var s = document.createElement('script');
      s.src = PYODIDE_JS;
      s.onload = doLoad;
      s.onerror = function () {
        pyLoading = false;
        showPyLoading(false);
        onErr('下载 Pyodide 运行时失败，请检查网络后重试');
      };
      document.body.appendChild(s);
    }
  }

  // ---------- 文件菜单 ----------
  function toggleFileMenu() {
    el('file-menu').classList.toggle('hidden');
  }
  function closeFileMenu() {
    el('file-menu').classList.add('hidden');
  }

  function newFile() {
    editor.setValue(DEFAULT_CODE);
    currentFileName = 'script.py';
    updateStatus();
    closeFileMenu();
    toast('已新建文件');
  }

  function openFile() {
    closeFileMenu();
    if (window.NativeBridge && window.NativeBridge.openFile) {
      try { window.NativeBridge.openFile(); return; } catch (e) {}
    }
    // 浏览器回退：本地文件选择
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.py,.txt,text/*';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        editor.setValue(String(r.result || ''));
        currentFileName = f.name;
        updateStatus();
        toast('已打开：' + f.name);
      };
      r.readAsText(f);
    };
    inp.click();
  }

  function saveFile() {
    closeFileMenu();
    var name = currentFileName || 'script.py';
    var content = editor.getValue();
    if (window.NativeBridge && window.NativeBridge.saveFile) {
      try { window.NativeBridge.saveFile(name, content); return; } catch (e) {}
    }
    // 浏览器回退：下载
    var blob = new Blob([content], { type: 'text/x-python' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // 原生回调（MainActivity 通过 evaluateJavascript 调用）
  window.__onFileOpened = function (data) {
    if (!data) return;
    editor.setValue(data.content || '');
    currentFileName = data.name || 'imported.py';
    updateStatus();
    toast('已打开：' + currentFileName);
  };

  window.__onFileSaved = function (data) {
    if (data && data.ok) {
      currentFileName = data.name || currentFileName;
      updateStatus();
      toast('已保存：' + currentFileName);
    } else {
      toast('保存失败');
    }
  };

  // ---------- AI 抽屉 ----------
  function toggleAi() {
    el('ai-drawer').classList.toggle('hidden');
  }

  function aiLog(role, text) {
    var box = el('ai-log');
    var d = document.createElement('div');
    d.className = 'msg ' + role;
    d.textContent = text;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  function aiErr(e) { aiLog('error', '请求失败：' + e); }

  function resolveEndpoint(base) {
    base = (base || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    if (/\/chat\/completions$/.test(base)) return base;
    if (/\/compatible-mode\/v1$/.test(base)) return base + '/chat/completions';
    if (/\/compatible-mode$/.test(base)) return base + '/chat/completions';
    if (/\/v1$/.test(base)) return base + '/chat/completions';
    return base + '/v1/chat/completions';
  }

  function callAI(prompt, onOk, onErr) {
    var key = localStorage.getItem(API_KEY_KEY);
    var base = localStorage.getItem(API_BASE_KEY);
    var model = localStorage.getItem(API_MODEL_KEY);
    if (!key || !base || !model) {
      openSettings();
      aiLog('system', '请先填写 API Key / 接口地址 / 模型');
      if (onErr) onErr('未配置 API');
      return;
    }
    var endpoint = resolveEndpoint(base);
    var body = {
      model: model,
      messages: [
        { role: 'system', content: '你是萝莉Python内置的编程助手，回答尽量简洁，需要代码时直接给出可用代码。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3
    };

    var xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', 'Bearer ' + key);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var json = JSON.parse(xhr.responseText);
          var reply = json.choices && json.choices[0] &&
                      json.choices[0].message && json.choices[0].message.content;
          if (reply) { onOk(reply); }
          else if (onErr) { onErr(JSON.stringify(json).slice(0, 300)); }
        } catch (e) { if (onErr) onErr(e.message); }
      } else {
        if (onErr) onErr(xhr.status + ' ' + xhr.statusText + ' ' + String(xhr.responseText || '').slice(0, 300));
      }
    };
    xhr.onerror = function () { if (onErr) onErr('网络错误'); };
    xhr.send(JSON.stringify(body));
  }

  function extractCode(text) {
    if (!text) return '';
    var m = text.match(/```(?:python|py)?\s*\n?([\s\S]*?)```/);
    if (m) return m[1].replace(/\n+$/, '');
    return text;
  }

  function onTool(e) {
    var t = e.currentTarget.getAttribute('data-tool');
    if (t === 'settings') { openSettings(); return; }

    var sel = editor.getSelection();
    var code = editor.getValue();
    var focus = sel || code;

    if (t === 'gen') {
      var req = el('ai-input').value.trim();
      if (!req) { aiLog('system', '请先在下方输入框写清楚要生成什么代码'); return; }
      var gp = '你是 Python 编程助手。请只输出可直接运行的 Python 代码，不要多余解释。\n需求：' + req;
      aiLog('user', '生成代码：' + req);
      callAI(gp, function (r) {
        aiLog('ai', r);
        var c = extractCode(r);
        if (c) { editor.replaceSelection(c); updateStatus(); }
      }, aiErr);
      return;
    }

    if (!code.trim()) { aiLog('system', '编辑器里还没有代码'); return; }

    var prompt = '';
    var replaceWhole = false;
    var insertAtCursor = false;
    var appendAtEnd = false;

    switch (t) {
      case 'explain':
        prompt = '请用通俗的语言解释下面这段 Python 代码：\n```python\n' + focus + '\n```';
        break;
      case 'fix':
        prompt = '下面代码有错误，请直接输出修正后的完整代码，不要额外解释：\n```python\n' + focus + '\n```';
        replaceWhole = true;
        break;
      case 'comment':
        prompt = '请给下面代码加上清晰的中文注释，输出加好注释的完整代码，不要额外解释：\n```python\n' + focus + '\n```';
        replaceWhole = true;
        break;
      case 'complete':
        prompt = '请续写下面这段 Python 代码（保持风格一致，直接输出续写的代码）：\n```python\n' + focus + '\n```';
        insertAtCursor = true;
        break;
      case 'optimize':
        prompt = '请优化下面 Python 代码（更简洁、更高效），直接输出优化后的完整代码：\n```python\n' + focus + '\n```';
        replaceWhole = true;
        break;
      case 'test':
        prompt = '请为下面 Python 代码生成单元测试（unittest），直接输出完整测试代码：\n```python\n' + focus + '\n```';
        appendAtEnd = true;
        break;
      default:
        return;
    }

    aiLog('user', prompt);
    callAI(prompt, function (r) {
      aiLog('ai', r);
      var c = extractCode(r);
      if (!c) return;
      if (replaceWhole) {
        if (sel) editor.replaceSelection(c); else editor.setValue(c);
      } else if (insertAtCursor) {
        editor.replaceSelection(c);
      } else if (appendAtEnd) {
        editor.replaceRange('\n\n' + c + '\n', { line: editor.lineCount(), ch: 0 });
      }
      updateStatus();
    }, aiErr);
  }

  function sendAi() {
    var inp = el('ai-input');
    var q = inp.value.trim();
    if (!q) return;
    inp.value = '';
    aiLog('user', q);
    callAI(q, function (r) { aiLog('ai', r); }, aiErr);
  }

  // ---------- 设置 ----------
  function openSettings() {
    el('in-key').value = localStorage.getItem(API_KEY_KEY) || '';
    el('in-base').value = localStorage.getItem(API_BASE_KEY) || 'https://api.deepseek.com';
    el('in-model').value = localStorage.getItem(API_MODEL_KEY) || 'deepseek-chat';
    el('settings-modal').classList.remove('hidden');
  }
  function closeSettings() {
    el('settings-modal').classList.add('hidden');
  }
  function saveSettings() {
    localStorage.setItem(API_KEY_KEY, el('in-key').value.trim());
    localStorage.setItem(API_BASE_KEY, el('in-base').value.trim());
    localStorage.setItem(API_MODEL_KEY, el('in-model').value.trim());
    closeSettings();
    aiLog('system', 'API 设置已保存（仅存本机）');
    toast('设置已保存');
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    el('btn-file').addEventListener('click', toggleFileMenu);
    el('btn-run').addEventListener('click', runCode);
    el('btn-stop').addEventListener('click', stopCode);
    el('btn-ai').addEventListener('click', toggleAi);
    el('btn-theme').addEventListener('click', toggleTheme);
    el('btn-clear').addEventListener('click', function () { el('output').textContent = ''; });
    el('btn-ai-close').addEventListener('click', toggleAi);
    el('btn-ai-send').addEventListener('click', sendAi);
    el('ai-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') sendAi();
    });

    document.querySelectorAll('#file-menu button').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = b.getAttribute('data-file');
        if (a === 'new') newFile();
        else if (a === 'open') openFile();
        else if (a === 'save') saveFile();
      });
    });

    document.querySelectorAll('#ai-drawer .tool').forEach(function (b) {
      b.addEventListener('click', onTool);
    });

    el('btn-cancel').addEventListener('click', closeSettings);
    el('btn-save').addEventListener('click', saveSettings);

    document.addEventListener('click', function (e) {
      var menu = el('file-menu');
      if (menu.classList.contains('hidden')) return;
      if (!menu.contains(e.target) && e.target !== el('btn-file')) {
        menu.classList.add('hidden');
      }
    });
  }

  // ---------- 启动 ----------
  function init() {
    loadTheme();
    initEditor();
    bindEvents();
    document.body.classList.remove('loading-mode');
    el('runtime-status').textContent = 'Python 环境未加载（点 ▶ 运行 时自动加载）';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
