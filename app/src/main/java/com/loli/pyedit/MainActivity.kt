package com.loli.pyedit

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.viewinterop.AndroidView

class MainActivity : ComponentActivity() {

    private var webView: WebView? = null

    /** 暴露给网页的桥：网页可通过 AndroidBridge.toast(...) / postMessage(...) 调用原生 */
    inner class AppBridge {
        @JavascriptInterface
        fun postMessage(json: String) {
            android.util.Log.d("LoliPy", "bridge: $json")
        }

        @JavascriptInterface
        fun toast(msg: String) {
            runOnUiThread {
                android.widget.Toast.makeText(
                    this@MainActivity, msg, android.widget.Toast.LENGTH_SHORT
                ).show()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = Color(0xFFFFF7FB)
                ) {
                    // 返回键：优先关闭网页里的抽屉/弹窗，其次再退出
                    BackHandler(enabled = true) {
                        val wv = webView
                        if (wv != null) {
                            wv.evaluateJavascript(
                                "window.__lolipyBack && window.__lolipyBack()", null
                            )
                        }
                    }
                    EditorScreen(
                        bridge = AppBridge(),
                        onWebViewReady = { wv -> webView = wv }
                    )
                }
            }
        }
    }

    override fun onDestroy() {
        webView?.destroy()
        webView = null
        super.onDestroy()
    }
}

@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
@Composable
fun EditorScreen(
    bridge: Any,
    onWebViewReady: (WebView) -> Unit
) {
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            WebView(ctx).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.allowFileAccess = true
                settings.allowContentAccess = true
                settings.mediaPlaybackRequiresUserGesture = false
                settings.setSupportZoom(false)
                settings.builtInZoomControls = false
                // 关键：file:// 页面访问 https 接口（DeepSeek / Pyodide CDN）不被混合内容策略拦死
                settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                @Suppress("DEPRECATION")
                settings.allowUniversalAccessFromFileURLs = true
                @Suppress("DEPRECATION")
                settings.allowFileAccessFromFileURLs = true

                // ===== 白屏根因修复 =====
                // 小米平板 8 Pro（Android 16 / Adreno GPU）上，WebView 的 Vulkan 硬件加速
                // 合成管线 shader 编译失败（AdrenoVK: Shader compilation failed /
                // Pipeline create failed），导致 WebView 内容渲染不出来、只见 Surface 背景
                // 的近白色。强制走软件渲染，绕过 GPU/Vulkan，恢复页面绘制。
                setLayerType(View.LAYER_TYPE_SOFTWARE, null)
                setBackgroundColor(0xFFFFF7FB.toInt())

                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView, request: WebResourceRequest
                    ): Boolean {
                        // 站内 file:// 与 CDN 资源都放行，不做外部跳转
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

                // 捕获网页 console，便于后续定位 JS 问题
                webChromeClient = object : WebChromeClient() {
                    override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                        android.util.Log.d(
                            "LoliPy",
                            "console[${msg.messageLevel()}]: ${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})"
                        )
                        return true
                    }
                }

                addJavascriptInterface(bridge, "AndroidBridge")
                loadUrl("file:///android_asset/index.html")
                onWebViewReady(this)
            }
        }
    )
}
