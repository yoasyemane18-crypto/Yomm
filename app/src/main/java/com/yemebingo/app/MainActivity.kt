package com.yemebingo.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.util.UUID

class MainActivity : ComponentActivity() {

    private var webViewRef: WebView? = null
    private var pendingScreen: String? = null
    private var requestPermissionAction: (() -> Unit)? = null

    companion object {
        const val CHANNEL_ID = "yeme_bingo_alerts"
        const val EXTRA_SCREEN = "screen"
        private const val PREFS_NAME = "yeme_push_prefs"
        private const val KEY_DEVICE_TOKEN = "native_device_token"
        private const val KEY_TOKEN_TS = "native_token_ts"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(AndroidColor.parseColor("#2A0F55")),
            navigationBarStyle = SystemBarStyle.dark(AndroidColor.parseColor("#0A0316"))
        )
        super.onCreate(savedInstanceState)
        ensureNotificationChannel()
        pendingScreen = extractScreenFromIntent(intent)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        setContent {
            var canGoBack by remember { mutableStateOf(false) }

            val notificationPermLauncher = rememberLauncherForActivityResult(
                contract = ActivityResultContracts.RequestPermission()
            ) { granted ->
                val token = getOrCreateNativeToken(rotateIfStale = false)
                notifyWebPermissionResult(granted, token)
            }

            requestPermissionAction = {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    val already = ContextCompat.checkSelfPermission(
                        this,
                        Manifest.permission.POST_NOTIFICATIONS
                    ) == PackageManager.PERMISSION_GRANTED
                    if (already) {
                        notifyWebPermissionResult(true, getOrCreateNativeToken(rotateIfStale = false))
                    } else {
                        notificationPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                } else {
                    val enabled = NotificationManagerCompat.from(this).areNotificationsEnabled()
                    notifyWebPermissionResult(enabled, getOrCreateNativeToken(rotateIfStale = false))
                }
            }

            BackHandler(enabled = canGoBack) {
                webViewRef?.goBack()
            }

            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(
                        Brush.verticalGradient(
                            colors = listOf(
                                Color(0xFF2A0F55),
                                Color(0xFF0A0316)
                            )
                        )
                    )
                    .windowInsetsPadding(WindowInsets.safeDrawing.union(WindowInsets.ime))
            ) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        WebView(ctx).apply {
                            layoutParams = ViewGroup.LayoutParams(
                                ViewGroup.LayoutParams.MATCH_PARENT,
                                ViewGroup.LayoutParams.MATCH_PARENT
                            )
                            setBackgroundColor(AndroidColor.parseColor("#0A0316"))
                            settings.apply {
                                javaScriptEnabled = true
                                domStorageEnabled = true
                                databaseEnabled = true
                                useWideViewPort = true
                                loadWithOverviewMode = true
                                mediaPlaybackRequiresUserGesture = false
                                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                            }
                            addJavascriptInterface(YemePushBridge(), "YemeAndroidPush")
                            webChromeClient = WebChromeClient()
                            webViewClient = object : WebViewClient() {
                                override fun shouldInterceptRequest(
                                    view: WebView,
                                    request: WebResourceRequest
                                ): WebResourceResponse? {
                                    return assetLoader.shouldInterceptRequest(request.url)
                                }

                                override fun shouldOverrideUrlLoading(
                                    view: WebView,
                                    request: WebResourceRequest
                                ): Boolean {
                                    val uri = request.url
                                    val scheme = uri.scheme?.lowercase()
                                    if (scheme == "tel") {
                                        try {
                                            ctx.startActivity(Intent(Intent.ACTION_DIAL, uri))
                                        } catch (_: Exception) {
                                        }
                                        return true
                                    }
                                    if (scheme == "yemebingo") {
                                        val deepScreen = uri.getQueryParameter(EXTRA_SCREEN)
                                        if (!deepScreen.isNullOrBlank()) {
                                            dispatchDeepLinkToWeb(deepScreen)
                                        }
                                        return true
                                    }
                                    if (uri.host != "appassets.androidplatform.net" &&
                                        (scheme == "http" || scheme == "https")
                                    ) {
                                        try {
                                            ctx.startActivity(Intent(Intent.ACTION_VIEW, uri))
                                        } catch (_: Exception) {
                                        }
                                        return true
                                    }
                                    return false
                                }

                                override fun doUpdateVisitedHistory(
                                    view: WebView,
                                    url: String?,
                                    isReload: Boolean
                                ) {
                                    canGoBack = view.canGoBack()
                                }

                                override fun onPageFinished(view: WebView, url: String?) {
                                    canGoBack = view.canGoBack()
                                    val scr = pendingScreen
                                    if (!scr.isNullOrBlank()) {
                                        pendingScreen = null
                                        dispatchDeepLinkToWeb(scr)
                                    }
                                }
                            }
                            val startUrl = if (!pendingScreen.isNullOrBlank()) {
                                "https://appassets.androidplatform.net/assets/index.html?screen=${Uri.encode(pendingScreen)}"
                            } else {
                                "https://appassets.androidplatform.net/assets/index.html"
                            }
                            loadUrl(startUrl)
                            webViewRef = this
                        }
                    }
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val screen = extractScreenFromIntent(intent)
        if (!screen.isNullOrBlank()) {
            pendingScreen = screen
            dispatchDeepLinkToWeb(screen)
        }
    }

    private fun extractScreenFromIntent(intent: Intent?): String? {
        if (intent == null) return null
        val fromExtra = intent.getStringExtra(EXTRA_SCREEN)
        if (!fromExtra.isNullOrBlank()) return fromExtra
        return intent.data?.getQueryParameter(EXTRA_SCREEN)
    }

    private fun dispatchDeepLinkToWeb(screen: String) {
        val safe = JSONObject.quote(screen)
        webViewRef?.post {
            webViewRef?.evaluateJavascript(
                "window.YemePush && window.YemePush.openScreen($safe);",
                null
            )
        }
    }

    private fun notifyWebPermissionResult(granted: Boolean, token: String) {
        val safeToken = JSONObject.quote(token)
        webViewRef?.post {
            webViewRef?.evaluateJavascript(
                "window.onYemePushPermissionResult && window.onYemePushPermissionResult($granted, $safeToken);",
                null
            )
        }
    }

    private fun hasNotificationPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            NotificationManagerCompat.from(this).areNotificationsEnabled()
        }
    }

    private fun getOrCreateNativeToken(rotateIfStale: Boolean): String {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        var token = prefs.getString(KEY_DEVICE_TOKEN, null)
        val issuedAt = prefs.getLong(KEY_TOKEN_TS, 0L)
        val sevenDaysMs = 7L * 24L * 60L * 60L * 1000L
        if (token.isNullOrBlank() || (rotateIfStale && System.currentTimeMillis() - issuedAt > sevenDaysMs)) {
            token = "and_" + UUID.randomUUID().toString().replace("-", "")
            prefs.edit()
                .putString(KEY_DEVICE_TOKEN, token)
                .putLong(KEY_TOKEN_TS, System.currentTimeMillis())
                .apply()
        }
        return token
    }

    private fun rotateNativeToken(): String {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val token = "and_" + UUID.randomUUID().toString().replace("-", "")
        prefs.edit()
            .putString(KEY_DEVICE_TOKEN, token)
            .putLong(KEY_TOKEN_TS, System.currentTimeMillis())
            .apply()
        return token
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Yeme Bingo Alerts",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Game rounds, jackpots, and wallet credit alerts in Amharic & English."
                enableLights(true)
                lightColor = AndroidColor.parseColor("#F0C75E")
                enableVibration(true)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm?.createNotificationChannel(channel)
        }
    }

    @SuppressLint("MissingPermission")
    private fun showSystemNotification(title: String, body: String, screen: String, notifId: Int) {
        if (!hasNotificationPermission()) return
        ensureNotificationChannel()
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_SCREEN, screen)
            data = Uri.parse("yemebingo://open?screen=${Uri.encode(screen)}")
        }
        val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pendingIntent = PendingIntent.getActivity(this, notifId, tapIntent, piFlags)

        val notif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setColor(AndroidColor.parseColor("#6D28D9"))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        NotificationManagerCompat.from(this).notify(notifId, notif)
    }

    inner class YemePushBridge {
        @JavascriptInterface
        fun isAndroidBridge(): Boolean = true

        @JavascriptInterface
        fun hasPermission(): Boolean = hasNotificationPermission()

        @JavascriptInterface
        fun requestPermission() {
            runOnUiThread {
                requestPermissionAction?.invoke()
            }
        }

        @JavascriptInterface
        fun getToken(rotateIfStale: Boolean): String = getOrCreateNativeToken(rotateIfStale)

        @JavascriptInterface
        fun rotateToken(): String = rotateNativeToken()

        @JavascriptInterface
        fun showLocalNotification(title: String, body: String, screen: String, notifId: Int): Boolean {
            if (!hasNotificationPermission()) return false
            showSystemNotification(
                title.ifBlank { "Yeme Bingo" },
                body,
                screen.ifBlank { "home" },
                if (notifId == 0) (System.currentTimeMillis() and 0x7FFFFFFF).toInt() else notifId
            )
            return true
        }
    }

    override fun onResume() {
        super.onResume()
        webViewRef?.onResume()
    }

    override fun onPause() {
        webViewRef?.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        webViewRef?.destroy()
        webViewRef = null
        super.onDestroy()
    }
}
