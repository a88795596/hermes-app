import AVFoundation
import UIKit

/// UI, permission, and audio-engine state stay on main; the model and streams stay on worker.
final class SpeechRecognitionRuntime {
  private final class Run {
    let id: String
    let event: (String, [String: Any]) -> Void
    var started: ((Result<Void, Error>) -> Void)?
    var stopped: [(Result<String, Error>) -> Void] = []
    var ending = false
    var engine: AVAudioEngine?
    var tapInstalled = false
    var ownsAudioSession = false
    var observers: [NSObjectProtocol] = []
    var lastText = ""

    // The tap and main thread enqueue while holding this lock, preserving stop-after-audio order.
    let lock = NSLock()
    var closed = false
    var cancelled = false
    var queuedSeconds = 0.0
    // Only worker touches the stream.
    var stream: StreamingTranscript?

    init(id: String, event: @escaping (String, [String: Any]) -> Void,
         started: @escaping (Result<Void, Error>) -> Void) {
      self.id = id
      self.event = event
      self.started = started
    }

    func settleStart(_ result: Result<Void, Error> = .success(())) {
      let callback = started
      started = nil
      callback?(result)
    }

    func status(_ state: String) { event("status", ["id": id, "state": state]) }
  }

  private let worker = DispatchQueue(label: "hermes.speech.inference", qos: .userInitiated)
  private var recognizer: StreamingRecognizer?
  private var current: Run?

  func start(id: String, event: @escaping (String, [String: Any]) -> Void,
             completion: @escaping (Result<Void, Error>) -> Void) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard !id.isEmpty, id.count <= 200 else {
      completion(.failure(SpeechFailure("无效的录音会话。")))
      return
    }
    guard current == nil else {
      completion(.failure(SpeechFailure("已有录音正在进行，请先结束当前录音。")))
      return
    }
    guard UIApplication.shared.applicationState == .active else {
      completion(.failure(SpeechFailure("请回到 App 前台再录音。")))
      return
    }
    let run = Run(id: id, event: event, started: completion)
    current = run
    run.status("starting")
    observe(run, UIApplication.didEnterBackgroundNotification) { [weak self] _ in
      self?.interrupt(run, message: "App 已进入后台，录音已停止，识别文字已保留。")
    }
    AVAudioSession.sharedInstance().requestRecordPermission { [weak self, weak run] granted in
      DispatchQueue.main.async {
        guard let self, let run, self.current === run, !run.ending else { return }
        guard granted else {
          self.failStart(run, error: SpeechFailure("未获得麦克风权限，请在系统设置中允许访问麦克风。"))
          return
        }
        self.load(run)
      }
    }
  }

  func stop(id: String, completion: @escaping (Result<String, Error>) -> Void) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard let run = current, run.id == id else { completion(.success("")); return }
    run.stopped.append(completion)
    finish(run)
  }

  func cancel(id: String) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard let run = current, run.id == id else { return }
    run.ending = true
    stopAudio(run)
    run.lock.lock()
    run.closed = true
    run.cancelled = true
    worker.async { run.stream = nil }
    run.lock.unlock()
    // Invalidating the identity before resolving also suppresses in-flight inference and permissions.
    current = nil
    run.status("idle")
    run.settleStart()
    run.stopped.forEach { $0(.success("")) }
    run.stopped.removeAll()
  }

  func destroy() {
    dispatchPrecondition(condition: .onQueue(.main))
    if let run = current { cancel(id: run.id) }
    worker.async { self.recognizer = nil }
  }

  private func load(_ run: Run) {
    let bundle = Bundle(for: SpeechRecognitionRuntime.self)
    guard let url = bundle.url(forResource: "HermesSpeechModel", withExtension: "bundle")
      ?? Bundle.main.url(forResource: "HermesSpeechModel", withExtension: "bundle") else {
      failStart(run, error: SpeechFailure("离线语音模型未打包，请运行 pnpm setup:speech 后重新构建 App。"))
      return
    }
    worker.async {
      run.lock.lock()
      let cancelled = run.cancelled
      run.lock.unlock()
      guard !cancelled else { return }
      do {
        if self.recognizer == nil { self.recognizer = try StreamingRecognizer(directory: url) }
        run.stream = try self.recognizer?.makeStream()
        DispatchQueue.main.async {
          guard self.current === run, !run.ending else { return }
          do { try self.beginAudio(run) }
          catch { self.failStart(run, error: error) }
        }
      } catch {
        DispatchQueue.main.async {
          guard self.current === run, !run.ending else { return }
          self.failStart(run, error: error)
        }
      }
    }
  }

  private func beginAudio(_ run: Run) throws {
    guard UIApplication.shared.applicationState == .active else {
      throw SpeechFailure("请回到 App 前台再录音。")
    }
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement, options: [.allowBluetoothHFP])
    try? session.setPreferredSampleRate(16_000)
    try? session.setPreferredIOBufferDuration(0.02)
    try session.setActive(true)
    run.ownsAudioSession = true
    let engine = AVAudioEngine()
    run.engine = engine
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.sampleRate <= 192_000, format.channelCount > 0,
          format.commonFormat == .pcmFormatFloat32 else {
      throw SpeechFailure("当前麦克风音频格式不可用，请检查音频设备。")
    }
    input.installTap(onBus: 0, bufferSize: 2_048, format: format) { [weak self, weak run] buffer, _ in
      guard let self, let run else { return }
      self.accept(buffer, sampleRate: format.sampleRate, run: run)
    }
    run.tapInstalled = true
    engine.prepare()
    try engine.start()
    observe(run, AVAudioSession.interruptionNotification) { [weak self] notification in
      guard (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt)
        == AVAudioSession.InterruptionType.began.rawValue else { return }
      self?.interrupt(run, message: "录音被系统音频中断，识别文字已保留。")
    }
    observe(run, AVAudioSession.routeChangeNotification) { [weak self] notification in
      guard let value = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
            let reason = AVAudioSession.RouteChangeReason(rawValue: value),
            reason == .oldDeviceUnavailable || reason == .newDeviceAvailable else { return }
      self?.interrupt(run, message: "麦克风设备已切换，录音已停止，识别文字已保留。")
    }
    observe(run, .AVAudioEngineConfigurationChange, object: engine) { [weak self] _ in
      self?.interrupt(run, message: "麦克风配置已改变，录音已停止，识别文字已保留。")
    }
    observe(run, AVAudioSession.mediaServicesWereResetNotification) { [weak self] _ in
      self?.interrupt(run, message: "系统音频服务已重启，录音已停止，识别文字已保留。")
    }
    run.status("recording")
    run.settleStart()
  }

  private func accept(_ buffer: AVAudioPCMBuffer, sampleRate: Double, run: Run) {
    guard buffer.frameLength > 0 else { return }
    let count = Int(buffer.frameLength)
    let duration = Double(count) / sampleRate
    run.lock.lock()
    defer { run.lock.unlock() }
    guard !run.closed else { return }
    guard buffer.format.sampleRate == sampleRate, let channels = buffer.floatChannelData else {
      run.closed = true
      DispatchQueue.main.async {
        self.interrupt(run, message: "麦克风音频格式已改变，录音已停止，识别文字已保留。")
      }
      return
    }
    // shortcut: cap queued audio at three seconds; upgrade inference if slower devices cannot keep up.
    guard run.queuedSeconds + duration <= 3 else {
      run.closed = true
      DispatchQueue.main.async {
        self.interrupt(run, message: "语音识别暂时跟不上录音速度，已停止并保留识别文字。")
      }
      return
    }
    let channelCount = Int(buffer.format.channelCount)
    var mono = [Float](repeating: 0, count: count)
    for frame in 0..<count {
      for channel in 0..<channelCount {
        mono[frame] += buffer.format.isInterleaved
          ? channels[0][frame * channelCount + channel] : channels[channel][frame]
      }
      mono[frame] /= Float(channelCount)
    }
    run.queuedSeconds += duration
    worker.async {
      run.lock.lock()
      let cancelled = run.cancelled
      run.lock.unlock()
      if !cancelled, let stream = run.stream {
        let text = stream.accept(mono, sampleRate: Int32(sampleRate))
        DispatchQueue.main.async {
          guard self.current === run, text != run.lastText else { return }
          run.lastText = text
          run.event("result", ["id": run.id, "text": text, "isFinal": false])
        }
      }
      run.lock.lock()
      run.queuedSeconds -= duration
      run.lock.unlock()
    }
  }

  private func finish(_ run: Run, message: String? = nil) {
    guard current === run, !run.ending else { return }
    run.ending = true
    stopAudio(run)
    run.status("stopping")
    run.lock.lock()
    run.closed = true
    worker.async {
      let text = run.stream?.finish() ?? ""
      run.stream = nil
      DispatchQueue.main.async {
        guard self.current === run else { return }
        run.event("result", ["id": run.id, "text": text, "isFinal": true])
        if let message { run.event("error", ["id": run.id, "message": message]) }
        self.current = nil
        run.status("idle")
        run.settleStart()
        let result: Result<String, Error> = message.map { .failure(SpeechFailure($0)) } ?? .success(text)
        run.stopped.forEach { $0(result) }
        run.stopped.removeAll()
      }
    }
    run.lock.unlock()
  }

  private func interrupt(_ run: Run, message: String) {
    guard current === run, !run.ending else { return }
    finish(run, message: message)
  }

  private func failStart(_ run: Run, error: Error) {
    guard current === run else { return }
    // Cancellation settles start successfully; genuine startup failures must reject it first.
    run.settleStart(.failure(error))
    run.event("error", ["id": run.id, "message": error.localizedDescription])
    cancel(id: run.id)
  }

  private func observe(_ run: Run, _ name: Notification.Name, object: AnyObject? = nil,
                       handler: @escaping (Notification) -> Void) {
    run.observers.append(NotificationCenter.default.addObserver(
      forName: name, object: object, queue: .main, using: handler))
  }

  private func stopAudio(_ run: Run) {
    run.observers.forEach { NotificationCenter.default.removeObserver($0) }
    run.observers.removeAll()
    if run.tapInstalled { run.engine?.inputNode.removeTap(onBus: 0); run.tapInstalled = false }
    run.engine?.stop()
    run.engine = nil
    if run.ownsAudioSession {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      run.ownsAudioSession = false
    }
  }
}
