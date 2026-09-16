package com.loli.pyedit

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.Toast
import org.json.JSONObject

/**
 * 萝莉Python 主界面（传统 Activity + WebView）。
 *
 * 白屏根治：全局关闭硬件加速（见 AndroidManifest.xml 的
 * android:hardwareAccelerated="false"），并在此对 WebView 再强制
 * 软件渲染，彻底绕开小米平板 8 Pro（Android 16 / Adreno GPU）上
 * WebView 的 Vulkan 合成 shader 编译失败问题。
 */
class MainActivity : Activity() {

    private var webView: WebView? = null
    private var pendingSaveName: String = "script.py"
    private var pendingSaveContent: String = ""

    companion object {
        private const val REQ_OPEN = 101
        private const val REQ_SAVE = 102
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val wv = createWebView()
        webView = wv
        setContentView(wv)
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun createWebView(): WebView {
        return WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.setSupportZoom(false)
            settings.builtInZoomControls = false
            settings.displayZoomControls = false
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            // file:// 页面可访问 https 接口（AI / Pyodide CDN），不被混合内容拦死
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            @Suppress("DEPRECATION")
            settings.allowUniversalAccessFromFileURLs = true
            @Suppress("DEPRECATION")
            settings.allowFileAccessFromFileURLs = true

            // 双保险：即使硬件加速开关被忽略，也强制 WebView 软件渲染
            setLayerType(View.LAYER_TYPE_SOFTWARE, null)
            setBackgroundColor(0xFFFFF7FB.toInt())

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean {
                    return false
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError
                ) {
                    android.util.Log.e(
                        "LoliPy",
                        "WebView error: ${error.errorCode} ${error.description} @ ${request.url}"
                    )
                    super.onReceivedError(view, request, error)
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                    android.util.Log.d(
                        "LoliPy",
                        "console[${msg.messageLevel()}]: ${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})"
                    )
                    return true
                }

                /**
                 * 让 Python 的 input() 能通过 window.prompt() 弹出原生输入框。
                 * Pyodide 同步执行时，JS 线程会阻塞在 prompt 上，这里在 UI 线程
                 * 弹出对话框，用户确认后 result.confirm(value) 解除阻塞。
                 */
                override fun onJsPrompt(
                    view: WebView?,
                    url: String?,
                    message: String?,
                    defaultValue: String?,
                    result: JsPromptResult
                ): Boolean {
                    try {
                        val input = EditText(this@MainActivity)
                        input.setText(defaultValue ?: "")
                        input.setSingleLine(true)
                        input.hint = "在这里输入…"
                        AlertDialog.Builder(this@MainActivity)
                            .setTitle(message ?: "请输入")
                            .setView(input)
                            .setPositiveButton("确定") { _, _ ->
                                result.confirm(input.text.toString())
                            }
                            .setNegativeButton("取消") { _, _ ->
                                result.cancel()
                            }
                            .setOnCancelListener { result.cancel() }
                            .show()
                    } catch (e: Exception) {
                        result.cancel()
                    }
                    return true
                }
            }

            addJavascriptInterface(NativeBridge(), "NativeBridge")
            loadUrl("file:///android_asset/index.html")
        }
    }

    /** 暴露给网页的原生桥：文件导入/导出、提示、平台信息 */
    inner class NativeBridge {
        @JavascriptInterface
        fun toast(msg: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, msg, Toast.LENGTH_SHORT).show()
            }
        }

        @JavascriptInterface
        fun getPlatform(): String = "android"

        /** 打开/导入文件：通过 SAF 让用户选择 .py / .txt 等文本文件 */
        @JavascriptInterface
        fun openFile() {
            runOnUiThread {
                try {
                    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        putExtra(
                            Intent.EXTRA_MIME_TYPES,
                            arrayOf(
                                "text/x-python",
                                "text/plain",
                                "text/x-python-script",
                                "application/octet-stream",
                                "text/*"
                            )
                        )
                    }
                    startActivityForResult(intent, REQ_OPEN)
                } catch (e: Exception) {
                    toast("无法打开文件选择器：" + e.message)
                }
            }
        }

        /** 保存/导出文件：通过 SAF 让用户选择保存位置 */
        @JavascriptInterface
        fun saveFile(name: String, content: String) {
            runOnUiThread {
                pendingSaveName = if (name.isBlank()) "script.py" else name
                pendingSaveContent = content ?: ""
                try {
                    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "text/x-python"
                        putExtra(Intent.EXTRA_TITLE, pendingSaveName)
                    }
                    startActivityForResult(intent, REQ_SAVE)
                } catch (e: Exception) {
                    toast("无法打开保存器：" + e.message)
                }
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK) return
        when (requestCode) {
            REQ_OPEN -> {
                val uri = data?.data ?: return
                val name = queryName(uri).ifBlank { "imported.py" }
                val content = readUri(uri)
                callback("window.__onFileOpened && window.__onFileOpened(" + jsonOf(name, content) + ")")
            }
            REQ_SAVE -> {
                val uri = data?.data ?: return
                val ok = writeUri(uri, pendingSaveContent)
                val name = queryName(uri).ifBlank { pendingSaveName }
                callback(
                    "window.__onFileSaved && window.__onFileSaved({ok:" + ok +
                        ", name:" + JSONObject.quote(name) + "})"
                )
            }
        }
    }

    private fun jsonOf(name: String, content: String): String {
        val j = JSONObject()
        j.put("name", name)
        j.put("content", content)
        return j.toString()
    }

    private fun callback(js: String) {
        runOnUiThread {
            webView?.evaluateJavascript(js, null)
        }
    }

    private fun queryName(uri: Uri): String {
        var name = ""
        try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0) name = c.getString(idx) ?: ""
                }
            }
        } catch (_: Exception) {
        }
        return name
    }

    private fun readUri(uri: Uri): String {
        return try {
            contentResolver.openInputStream(uri)
                ?.bufferedReader(Charsets.UTF_8)
                ?.use { it.readText() } ?: ""
        } catch (e: Exception) {
            Toast.makeText(this, "读取失败：" + e.message, Toast.LENGTH_SHORT).show()
            ""
        }
    }

    private fun writeUri(uri: Uri, content: String): Boolean {
        return try {
            contentResolver.openOutputStream(uri)
                ?.use { it.write(content.toByteArray(Charsets.UTF_8)) }
            true
        } catch (e: Exception) {
            Toast.makeText(this, "保存失败：" + e.message, Toast.LENGTH_SHORT).show()
            false
        }
    }

    override fun onDestroy() {
        webView?.destroy()
        webView = null
        super.onDestroy()
    }
}
