package computer.playground.rokidtest

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.WindowManager
import android.view.WindowInsets
import android.widget.*
import okhttp3.*
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.math.sqrt

class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val prefs by lazy { getSharedPreferences("settings", MODE_PRIVATE) }
    private val client = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build()
    private val wireLock = Any()
    private var socket: WebSocket? = null
    private var connected = false
    private var wantConnection = false
    private var foreground = false
    private var retrySeconds = 3L
    private var retry: Runnable? = null
    @Volatile private var recording = false
    private var recorder: AudioRecord? = null
    private var audioThread: Thread? = null
    private var sampleRate = 24000
    private lateinit var status: TextView
    private lateinit var levels: TextView
    private lateinit var caption: TextView
    private lateinit var captionScroll: ScrollView
    private lateinit var translationStatus: TextView
    private lateinit var diagnostic: TextView
    private lateinit var micButton: Button
    private lateinit var connectButton: Button
    private val recent = ArrayDeque<String>()
    private var lastTouchLog = 0L
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(16, 12, 16, 12); setBackgroundColor(Color.BLACK)
            setOnApplyWindowInsetsListener { view, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                view.setPadding(16 + bars.left, 12 + bars.top, 16 + bars.right, 12 + bars.bottom)
                insets
            }
        }
        fun label(text: String, size: Float = 16f): TextView = TextView(this).apply {
            this.text = text; textSize = size; setTextColor(Color.GREEN); setPadding(0, 5, 0, 5); layout.addView(this)
        }
        status = label("My Translate ${BuildConfig.VERSION_NAME} · disconnected", 12f)
        levels = label("Microphone idle", 12f)
        translationStatus = label("Enable translation in the dashboard", 12f)
        caption = TextView(this).apply {
            text = "Ready for translation…"; textSize = 26f; setTextColor(Color.GREEN)
            setPadding(0, 4, 0, 4); setLineSpacing(2f, 1.05f)
        }
        captionScroll = ScrollView(this).apply { addView(caption); isFocusable = false }
        layout.addView(captionScroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val controlScroll = HorizontalScrollView(this).apply {
            addView(controls); isHorizontalScrollBarEnabled = true
        }
        layout.addView(controlScroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        fun button(text: String, action: () -> Unit): Button = Button(this).apply {
            this.text = text; isAllCaps = false; isFocusable = true; textSize = 12f
            minWidth = 0; minimumWidth = 0; minHeight = 0; minimumHeight = 0
            setPadding((10 * resources.displayMetrics.density).toInt(), 0, (10 * resources.displayMetrics.density).toInt(), 0)
            val brightStates = arrayOf(
                intArrayOf(android.R.attr.state_pressed),
                intArrayOf(android.R.attr.state_focused),
                intArrayOf(android.R.attr.state_selected),
                intArrayOf()
            )
            val border = (2 * resources.displayMetrics.density).toInt().coerceAtLeast(1)
            backgroundTintList = null
            background = StateListDrawable().apply {
                brightStates.forEachIndexed { index, state ->
                    addState(state, GradientDrawable().apply {
                        setColor(if (index < 3) Color.GREEN else Color.BLACK)
                        setStroke(border, Color.GREEN)
                        cornerRadius = 6 * resources.displayMetrics.density
                    })
                }
            }
            setTextColor(ColorStateList(brightStates, intArrayOf(Color.BLACK, Color.BLACK, Color.BLACK, Color.GREEN)))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, (36 * resources.displayMetrics.density).toInt()).apply {
                rightMargin = (8 * resources.displayMetrics.density).toInt()
            }
            setOnClickListener { action() }; controls.addView(this)
        }
        micButton = button("Start mic") { if (recording) stopMic() else requestMic() }
        connectButton = button("Connect") { if (wantConnection) disconnect() else { wantConnection = true; connect() } }
        button("Settings") { settings() }
        button("Device") { showDeviceInfo() }
        button("Log") { showDiagnostic(recent.takeLast(20).joinToString("\n"), "log_viewed") }
        button("Exit") { finish() }
        diagnostic = TextView(this) // Detailed input/network messages remain in the Log dialog.
        val viewport = object : FrameLayout(this) {
            override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
                super.onSizeChanged(w, h, oldw, oldh)
                // Reserve the lower fifth of the window; focused controls scroll within the rest.
                setPadding(0, 0, 0, (h * 0.20f).toInt())
            }
        }.apply {
            setBackgroundColor(Color.BLACK)
            addView(layout, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        setContentView(viewport)
        runCatching { File(filesDir, "diagnostic.log").readLines().takeLast(60).forEach { recent.addLast(it) } }
        log("launch", "${android.os.Build.MODEL} / Android ${android.os.Build.VERSION.RELEASE}")
        micButton.requestFocus()
    }

    override fun onStart() {
        super.onStart(); foreground = true
    }
    override fun onStop() {
        foreground = false; stopMic(); disconnect(); super.onStop()
    }
    override fun onDestroy() {
        client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll(); super.onDestroy()
    }

    private fun deviceInfoLines(): List<String> = listOf(
        "Android ${Build.VERSION.RELEASE} / API ${Build.VERSION.SDK_INT}",
        "Model: ${Build.MANUFACTURER} ${Build.MODEL}",
        "Firmware: ${Build.DISPLAY}",
        "Security patch: ${Build.VERSION.SECURITY_PATCH}",
        "App ${BuildConfig.VERSION_NAME}: min API ${applicationInfo.minSdkVersion}, target ${applicationInfo.targetSdkVersion}"
    )

    private fun showDeviceInfo() {
        showDiagnostic(deviceInfoLines().joinToString("\n"), "device_info_viewed")
    }

    private fun showDiagnostic(message: String, event: String) {
        // Keep device information and local logs compact; translation captions use their own font size.
        caption.textSize = 14f
        caption.text = message
        captionScroll.post { captionScroll.scrollTo(0, 0) }
        log(event)
    }

    private fun log(event: String, value: String = "") {
        if (Looper.myLooper() != Looper.getMainLooper()) { handler.post { log(event, value) }; return }
        val cleanValue = value.replace(Regex("[\\r\\n]"), " ").take(120)
        val line = "${System.currentTimeMillis()} $event $cleanValue"
        recent.addLast(line); while (recent.size > 80) recent.removeFirst()
        diagnostic.text = "$event $cleanValue"
        try {
            val file = File(filesDir, "diagnostic.log")
            if (file.length() > 128 * 1024) file.writeText("")
            file.appendText(line + "\n")
        } catch (_: Exception) { diagnostic.text = "Local log write failed" }
        send(JSONObject().put("type", "diagnostic").put("event", event).put("value", cleanValue))
    }
    private fun send(message: JSONObject) = synchronized(wireLock) {
        if (connected) socket?.send(message.toString()) else false
    }
    private fun baseUrl(): HttpUrl? {
        val raw = prefs.getString("url", BuildConfig.SERVER_URL)!!.trim()
        val parsed = runCatching { Request.Builder().url(raw).build().url }.getOrNull() ?: return null
        // Cleartext is permitted only for an emulator reaching the Windows host.
        if (parsed.scheme != "https" && !(BuildConfig.DEBUG && parsed.host in listOf("10.0.2.2", "127.0.0.1", "localhost"))) return null
        if (parsed.username.isNotEmpty() || parsed.password.isNotEmpty() || parsed.encodedPath != "/" || parsed.query != null) return null
        return parsed
    }
    private fun connect() {
        if (!foreground || !wantConnection) return
        retry?.let { handler.removeCallbacks(it) }; retry = null
        val url = baseUrl()
        val token = prefs.getString("token", BuildConfig.DEVICE_TOKEN)!!.trim()
        if (url == null || token.length < 24) {
            wantConnection = false; status.text = "Set server URL and device token in Settings"; settings(); return
        }
        status.text = "Connecting…"; connectButton.text = "Disconnect"
        val request = Request.Builder().url(url.newBuilder().addPathSegment("device").build()).header("Authorization", "Bearer $token").build()
        synchronized(wireLock) {
            socket = client.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(ws: WebSocket, response: Response) { handler.post {
                    synchronized(wireLock) {
                        if (socket !== ws || !foreground || !wantConnection) { ws.close(1000, "Cancelled"); return@post }
                        connected = true; retrySeconds = 3
                        ws.send(JSONObject().put("type", "hello").put("name", android.os.Build.MODEL).put("appVersion", BuildConfig.VERSION_NAME).toString())
                        if (recording) sendStreamStart()
                    }
                    status.text = "Server connected"; log("connected")
                    deviceInfoLines().forEach { log("device_info", it) }
                } }
                override fun onMessage(ws: WebSocket, text: String) { handler.post {
                    if (socket !== ws) return@post
                    try {
                        val m = JSONObject(text)
                        when (m.optString("type")) {
                            "caption" -> {
                                caption.text = m.optString("text").takeLast(400)
                                caption.textSize = m.optInt("fontSize", 26).coerceIn(22, 34).toFloat()
                                captionScroll.post { captionScroll.fullScroll(android.view.View.FOCUS_DOWN) }
                                send(JSONObject().put("type", "caption_ack").put("captionId", m.optString("captionId")))
                                if (!m.optBoolean("live")) log("caption_applied")
                            }
                            "translation_status" -> { translationStatus.text = "OpenAI · ${m.optString("state")}" }
                            "stats" -> {
                                status.text = "Connected · received ${m.optLong("bytes") / 1024} KiB"
                                send(JSONObject().put("type", "ping").put("sentAt", SystemClock.elapsedRealtime()))
                            }
                            "pong" -> { diagnostic.text = "Network RTT: ${SystemClock.elapsedRealtime() - m.optLong("sentAt")} ms" }
                            "error" -> log("server_error", m.optString("message"))
                        }
                    } catch (_: Exception) { log("invalid_server_message") }
                } }
                override fun onClosing(ws: WebSocket, code: Int, reason: String) { ws.close(code, null) }
                override fun onClosed(ws: WebSocket, code: Int, reason: String) { lost(ws, "closed_$code", code == 1008) }
                override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                    lost(ws, response?.let { "http_${it.code}" } ?: t.javaClass.simpleName, response?.code in listOf(401, 403))
                }
            })
        }
    }
    private fun lost(ws: WebSocket, reason: String, fatal: Boolean) { handler.post {
        synchronized(wireLock) { if (socket !== ws) return@post; connected = false; socket = null }
        log("connection_lost", reason)
        if (fatal) wantConnection = false
        status.text = if (fatal) "Connection rejected; check token / settings" else "Disconnected · $reason"
        if (wantConnection && foreground) {
            status.text = "Retry in ${retrySeconds}s · $reason"
            retry = Runnable { connect() }.also { handler.postDelayed(it, retrySeconds * 1000) }
            retrySeconds = (retrySeconds * 2).coerceAtMost(24)
        } else connectButton.text = "Connect"
    } }
    private fun disconnect() {
        wantConnection = false; retry?.let { handler.removeCallbacks(it) }; retry = null
        synchronized(wireLock) { connected = false; socket?.close(1000, "User disconnected"); socket = null }
        if (::status.isInitialized) { status.text = "Server disconnected"; connectButton.text = "Connect"; translationStatus.text = "Translation disconnected" }
    }
    private fun sendStreamStart() {
        send(JSONObject().put("type", "stream_start").put("format", "pcm16le").put("channels", 1).put("sampleRate", sampleRate))
    }
    private fun requestMic() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        else startMic()
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 1 && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED && foreground) startMic()
        else log("microphone_permission_denied")
    }
    private fun startMic() {
        if (recording || !foreground) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            log("microphone_permission_denied"); return
        }
        var chosen: AudioRecord? = null
        for (rate in listOf(24000, 48000, 16000, 44100)) {
            try {
                val minimum = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
                if (minimum <= 0) continue
                val candidate = AudioRecord(MediaRecorder.AudioSource.MIC, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum * 2, rate * 2))
                if (candidate.state != AudioRecord.STATE_INITIALIZED) { candidate.release(); continue }
                try { candidate.startRecording() } catch (e: Exception) { candidate.release(); throw e }
                if (candidate.recordingState != AudioRecord.RECORDSTATE_RECORDING) { candidate.release(); continue }
                chosen = candidate; sampleRate = rate; break
            } catch (_: Exception) { /* Try the next supported capture rate. */ }
        }
        val audio = chosen ?: run { log("microphone_unavailable", "Permission, firmware or another app may block capture"); return }
        recorder = audio
        synchronized(wireLock) { recording = true; sendStreamStart() }
        micButton.text = "Stop mic"; log("microphone_started", "$sampleRate Hz / PCM16 mono")
        audioThread = Thread({
            val buffer = ByteArray(sampleRate * 2 / 5) // 200 ms PCM16
            var failure = false
            while (recording) {
                val count = audio.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                if (count <= 0) { if (recording) failure = true; break }
                var sum = 0.0
                for (i in 0 until count - 1 step 2) {
                    val sample = ((buffer[i].toInt() and 255) or (buffer[i + 1].toInt() shl 8)).toShort().toDouble() / 32768
                    sum += sample * sample
                }
                val rms = sqrt(sum / (count / 2))
                handler.post { if (recording) levels.text = "Mic ${sampleRate} Hz · level ${"%.3f".format(rms * 100)}%" }
                synchronized(wireLock) {
                    if (recording && connected) {
                        val ws = socket
                        if (ws != null && ws.queueSize() > sampleRate * 2L) {
                            // Drop the stale connection instead of building a minute-long audio backlog.
                            ws.cancel()
                        } else ws?.send(buffer.toByteString(0, count))
                    }
                }
            }
            if (failure) handler.post { log("microphone_read_failed"); stopMic() }
        }, "microphone-capture").also { it.start() }
    }
    private fun stopMic() {
        if (!recording) return
        synchronized(wireLock) { recording = false }
        try { recorder?.stop() } catch (_: Exception) {}
        audioThread?.join(500)
        recorder?.release(); recorder = null; audioThread = null
        send(JSONObject().put("type", "stream_stop"))
        micButton.text = "Start mic"; levels.text = "Microphone idle"; log("microphone_stopped")
    }
    private fun settings() {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(20, 8, 20, 8) }
        val url = EditText(this).apply { hint = "https://translate.playground.computer"; setSingleLine(); setText(prefs.getString("url", BuildConfig.SERVER_URL)); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI }
        val token = EditText(this).apply { hint = "Device token from server .env"; setSingleLine(); setText(prefs.getString("token", BuildConfig.DEVICE_TOKEN)); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        box.addView(url); box.addView(token)
        AlertDialog.Builder(this).setTitle("Server settings").setView(box).setNegativeButton("Cancel", null).setPositiveButton("Save") { _, _ ->
            disconnect(); prefs.edit().putString("url", url.text.toString().trim()).putString("token", token.text.toString().trim()).apply(); log("settings_saved")
        }.show()
    }
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) log("key", "code=${event.keyCode}")
        return super.dispatchKeyEvent(event)
    }
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_UP && SystemClock.elapsedRealtime() - lastTouchLog > 1000) {
            lastTouchLog = SystemClock.elapsedRealtime(); log("touch", "x=${event.x.toInt()} y=${event.y.toInt()}")
        }
        return super.dispatchTouchEvent(event)
    }
}
