package expo.modules.hermesspeech

import android.Manifest
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
import android.media.AudioRouting
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.k2fsa.sherpa.onnx.EndpointConfig
import com.k2fsa.sherpa.onnx.EndpointRule
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

class HermesSpeechRecognitionModule : Module() {
  private class Run(val id: String, var started: Promise?) {
    val stopped = mutableListOf<Promise>()
    var ending = false
    var permissionGranted = false
    var loading = false
    var readerStarted = false
    var recorder: AudioRecord? = null
    var focus: AudioFocusRequest? = null
    var focusListener: AudioManager.OnAudioFocusChangeListener? = null
    var routing: AudioRouting.OnRoutingChangedListener? = null
    var recordingCallback: AudioManager.AudioRecordingCallback? = null
    var deviceId: Int? = null
    var lastText = ""
    var failure: String? = null
    @Volatile var reading = false
    val lock = Any()
    var cancelled = false
    var finishing = false
    var queuedSeconds = 0.0
    // Only the inference executor accesses this stream.
    var stream: StreamingTranscript? = null
  }

  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "hermes-speech-inference") }
  private var recognizer: OnlineRecognizer? = null
  private var current: Run? = null
  private var foreground = true
  private var destroyed = false
  private val context get() = requireNotNull(appContext.reactContext) { "App 尚未准备就绪。" }
  private val audioManager get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private fun isForeground() = foreground && (appContext.currentActivity as? LifecycleOwner)
    ?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true
  private fun onMain(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) action() else main.post(action)
  }

  override fun definition() = ModuleDefinition {
    Name("HermesSpeechRecognition")
    Events("result", "status", "error")
    Function("isAvailable") { true }

    AsyncFunction("start") { id: String, promise: Promise -> start(id, promise) }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") { id: String, promise: Promise ->
      val run = current
      if (run == null || run.id != id) promise.resolve("")
      else {
        run.stopped.add(promise)
        finish(run)
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("cancel") { id: String -> current?.takeIf { it.id == id }?.let(::cancel) }.runOnQueue(Queues.MAIN)

    OnActivityEntersBackground {
      onMain {
        foreground = false
        // Permission dialogs also pause the Activity; no microphone exists while permission is pending.
        current?.takeIf { it.readerStarted }?.let { interrupt(it, "App 已进入后台，录音已停止，识别文字已保留。") }
      }
    }
    OnActivityEntersForeground {
      onMain {
        foreground = true
        current?.takeIf { it.permissionGranted }?.let(::load)
      }
    }
    OnDestroy {
      onMain {
        destroyed = true
        current?.let(::cancel)
        worker.execute { recognizer?.release(); recognizer = null }
        worker.shutdown()
      }
    }
  }

  private fun start(id: String, promise: Promise) {
    val error = when {
      id.isBlank() || id.length > 200 -> "无效的录音会话。"
      destroyed || !isForeground() -> "请回到 App 前台再录音。"
      current != null -> "已有录音正在进行，请先结束当前录音。"
      else -> null
    }
    if (error != null) { promise.reject("SPEECH_START_FAILED", error, null); return }
    val run = Run(id, promise)
    current = run
    status(run, "starting")
    val permissions = appContext.permissions
    if (permissions == null) { failStart(run, IllegalStateException("无法请求麦克风权限。")); return }
    try {
      permissions.askForPermissions({ responses ->
        main.post {
          if (current !== run || run.ending) return@post
          if (responses[Manifest.permission.RECORD_AUDIO]?.status != PermissionsStatus.GRANTED) {
            failStart(run, IllegalStateException("未获得麦克风权限，请在系统设置中允许访问麦克风。"))
          } else {
            run.permissionGranted = true
            load(run)
          }
        }
      }, Manifest.permission.RECORD_AUDIO)
    } catch (failure: Exception) { failStart(run, failure) }
  }

  private fun load(run: Run) {
    if (current !== run || run.ending || run.loading || !foreground) return
    run.loading = true
    val assets = context.assets
    worker.execute {
      if (synchronized(run.lock) { run.cancelled }) return@execute
      try {
        if (recognizer == null) recognizer = OnlineRecognizer(assets, OnlineRecognizerConfig(
          featConfig = FeatureConfig(sampleRate = 16_000, featureDim = 80),
          modelConfig = OnlineModelConfig(
            transducer = OnlineTransducerModelConfig("encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx"),
            tokens = "tokens.txt", numThreads = 2, provider = "cpu", modelType = "zipformer2",
          ),
          endpointConfig = EndpointConfig(
            EndpointRule(false, 2.4f, 0f), EndpointRule(true, 1.2f, 0f), EndpointRule(false, 0f, 20f),
          ),
          enableEndpoint = true, decodingMethod = "greedy_search", maxActivePaths = 4,
        ))
        run.stream = StreamingTranscript(requireNotNull(recognizer))
        main.post {
          if (current !== run || run.ending) return@post
          try { beginAudio(run) } catch (failure: Exception) { failStart(run, failure) }
        }
      } catch (failure: Exception) {
        main.post { if (current === run && !run.ending) failStart(run, failure) }
      }
    }
  }

  private fun beginAudio(run: Run) {
    check(isForeground()) { "请回到 App 前台再录音。" }
    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      if (change < 0) main.post { interrupt(run, "录音被系统音频中断，识别文字已保留。") }
    }
    run.focusListener = listener
    val focusResult = if (Build.VERSION.SDK_INT >= 26) {
      val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setOnAudioFocusChangeListener(listener, main).build()
      run.focus = focus
      audioManager.requestAudioFocus(focus)
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
    }
    check(focusResult == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "麦克风暂时不可用，请稍后重试。" }
    val recorder = createRecorder()
    run.recorder = recorder
    run.deviceId = recorder.routedDevice?.id
    run.routing = AudioRouting.OnRoutingChangedListener { route ->
      val next = route.routedDevice?.id
      if (run.deviceId != null && next != run.deviceId) interrupt(run, "麦克风设备已切换，录音已停止，识别文字已保留。")
      run.deviceId = next
    }.also { recorder.addOnRoutingChangedListener(it, main) }
    if (Build.VERSION.SDK_INT >= 29) {
      run.recordingCallback = object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
          if (configs.any { it.clientAudioSessionId == recorder.audioSessionId && it.isClientSilenced }) {
            interrupt(run, "麦克风已被系统暂停，录音已停止，识别文字已保留。")
          }
        }
      }.also { callback -> recorder.registerAudioRecordingCallback({ main.post(it) }, callback) }
    }
    recorder.startRecording()
    check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "无法启动麦克风。" }
    run.reading = true
    val reader = Thread({ readAudio(run, recorder) }, "hermes-speech-microphone")
    reader.start()
    run.readerStarted = true
    status(run, "recording")
    run.started?.resolve()
    run.started = null
  }

  private fun createRecorder(): AudioRecord {
    for (rate in listOf(16_000, 48_000, 44_100)) {
      val minimum = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      if (minimum <= 0) continue
      val recorder = try {
        AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
          .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
          .setBufferSizeInBytes(maxOf(minimum * 2, rate * 2 / 5)).build()
      } catch (_: UnsupportedOperationException) { continue }
      if (recorder.state == AudioRecord.STATE_INITIALIZED && recorder.sampleRate > 0) return recorder
      recorder.release()
    }
    error("当前麦克风音频格式不可用，请检查音频设备。")
  }

  private fun readAudio(run: Run, recorder: AudioRecord) {
    val rate = recorder.sampleRate
    val buffer = ShortArray(rate / 10)
    try {
      while (run.reading) {
        val count = recorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
        if (count > 0) {
          val duration = count.toDouble() / rate
          synchronized(run.lock) {
            if (run.cancelled || run.finishing) return@synchronized
            // shortcut: queue at most three seconds; upgrade the model if this device cannot keep up.
            if (run.queuedSeconds + duration > 3) {
              run.reading = false
              main.post { recordingFailure(run, "语音识别暂时跟不上录音速度，已停止并保留识别文字。") }
              return@synchronized
            }
            val samples = FloatArray(count) { buffer[it] / 32768f }
            run.queuedSeconds += duration
            worker.execute {
              try {
                if (!synchronized(run.lock) { run.cancelled }) {
                  val text = run.stream?.accept(samples, rate).orEmpty()
                  main.post {
                    if (current === run && text != run.lastText) {
                      run.lastText = text
                      result(run, text, false)
                    }
                  }
                }
              } catch (_: Exception) {
                main.post { recordingFailure(run, "语音识别已中断，已识别文字已保留。") }
              } finally {
                synchronized(run.lock) { run.queuedSeconds -= duration }
              }
            }
          }
        } else if (run.reading) {
          run.reading = false
          main.post { recordingFailure(run, "无法继续读取麦克风，已识别文字已保留。") }
        }
      }
    } catch (_: Exception) {
      if (run.reading) main.post { recordingFailure(run, "录音已中断，已识别文字已保留。") }
    } finally {
      recorder.release()
      queueFinish(run)
    }
  }

  private fun finish(run: Run) {
    if (current !== run || run.ending) return
    run.ending = true
    status(run, "stopping")
    stopAudio(run)
    if (!run.readerStarted) queueFinish(run)
  }

  private fun queueFinish(run: Run) {
    synchronized(run.lock) {
      if (run.finishing || run.cancelled) return
      run.finishing = true
      worker.execute {
        var failure: String? = null
        val text = try { run.stream?.finish() } catch (_: Exception) {
          failure = "无法完成最后一段识别，已识别文字已保留。"
          null
        } finally {
          run.stream?.release()
          run.stream = null
        }
        main.post {
          if (current !== run) return@post
          val final = text?.takeIf { it.isNotEmpty() } ?: run.lastText
          val error = run.failure ?: failure
          result(run, final, true)
          error?.let { sendEvent("error", mapOf("id" to run.id, "message" to it)) }
          current = null
          status(run, "idle")
          run.started?.resolve()
          run.started = null
          run.stopped.forEach {
            if (error == null) it.resolve(final) else it.reject("SPEECH_INTERRUPTED", error, null)
          }
          run.stopped.clear()
        }
      }
    }
  }

  private fun stopAudio(run: Run) {
    run.reading = false
    run.recorder?.let { recorder ->
      run.routing?.let { runCatching { recorder.removeOnRoutingChangedListener(it) } }
      if (Build.VERSION.SDK_INT >= 29) run.recordingCallback?.let { runCatching { recorder.unregisterAudioRecordingCallback(it) } }
      runCatching { recorder.stop() }
      if (!run.readerStarted) recorder.release()
    }
    run.routing = null
    run.recordingCallback = null
    if (Build.VERSION.SDK_INT >= 26) run.focus?.let { runCatching { audioManager.abandonAudioFocusRequest(it) } }
    else run.focusListener?.let {
      @Suppress("DEPRECATION")
      runCatching { audioManager.abandonAudioFocus(it) }
    }
    run.focus = null
    run.focusListener = null
  }

  private fun cancel(run: Run) {
    if (current !== run) return
    run.ending = true
    synchronized(run.lock) { run.cancelled = true }
    stopAudio(run)
    current = null
    status(run, "idle")
    run.started?.resolve()
    run.started = null
    run.stopped.forEach { it.resolve(run.lastText) }
    run.stopped.clear()
    worker.execute { run.stream?.release(); run.stream = null }
  }

  private fun interrupt(run: Run, message: String) {
    if (current !== run || run.ending) return
    recordingFailure(run, message)
  }

  private fun recordingFailure(run: Run, message: String) {
    if (current !== run) return
    run.failure = message
    finish(run)
  }

  private fun failStart(run: Run, failure: Exception) {
    if (current !== run) return
    val message = failure.message ?: "无法开始语音输入。"
    run.started?.reject("SPEECH_START_FAILED", message, failure)
    run.started = null
    sendEvent("error", mapOf("id" to run.id, "message" to message))
    cancel(run)
  }

  private fun status(run: Run, state: String) = sendEvent("status", mapOf("id" to run.id, "state" to state))
  private fun result(run: Run, text: String, final: Boolean) = sendEvent("result", mapOf("id" to run.id, "text" to text, "isFinal" to final))
}
