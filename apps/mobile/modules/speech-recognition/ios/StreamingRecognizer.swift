import Foundation
import SherpaOnnxC

/// All instances and their streams are used exclusively on the inference queue.
final class StreamingRecognizer {
  let handle: OpaquePointer

  init(directory: URL) throws {
    let files = ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"]
      .map { directory.appendingPathComponent($0).path }
    guard files.allSatisfy({ FileManager.default.fileExists(atPath: $0) }) else {
      throw SpeechFailure("离线语音模型缺失，请运行 pnpm setup:speech 后重新构建 App。")
    }
    let strings = (files + ["cpu", "zipformer2", "greedy_search"]).map { strdup($0)! }
    defer { strings.forEach { free($0) } }
    var config = SherpaOnnxOnlineRecognizerConfig()
    config.feat_config.sample_rate = 16_000
    config.feat_config.feature_dim = 80
    config.model_config.transducer.encoder = UnsafePointer(strings[0])
    config.model_config.transducer.decoder = UnsafePointer(strings[1])
    config.model_config.transducer.joiner = UnsafePointer(strings[2])
    config.model_config.tokens = UnsafePointer(strings[3])
    config.model_config.provider = UnsafePointer(strings[4])
    config.model_config.model_type = UnsafePointer(strings[5])
    config.model_config.num_threads = 2
    config.decoding_method = UnsafePointer(strings[6])
    config.max_active_paths = 4
    config.enable_endpoint = 1
    config.rule1_min_trailing_silence = 2.4
    config.rule2_min_trailing_silence = 1.2
    config.rule3_min_utterance_length = 20
    guard let handle = SherpaOnnxCreateOnlineRecognizer(&config) else {
      throw SpeechFailure("离线语音模型加载失败，请重新准备模型并构建 App。")
    }
    self.handle = handle
  }

  deinit { SherpaOnnxDestroyOnlineRecognizer(handle) }

  func makeStream() throws -> StreamingTranscript {
    guard let stream = SherpaOnnxCreateOnlineStream(handle) else {
      throw SpeechFailure("无法创建语音识别会话。")
    }
    return StreamingTranscript(recognizer: self, stream: stream)
  }
}

final class StreamingTranscript {
  private let recognizer: StreamingRecognizer
  private let stream: OpaquePointer
  private var committed = ""
  private var inputSampleRate: Int32 = 16_000

  fileprivate init(recognizer: StreamingRecognizer, stream: OpaquePointer) {
    self.recognizer = recognizer
    self.stream = stream
  }

  deinit { SherpaOnnxDestroyOnlineStream(stream) }

  func accept(_ samples: [Float], sampleRate: Int32) -> String {
    inputSampleRate = sampleRate
    samples.withUnsafeBufferPointer {
      // sherpa resamples the microphone's hardware sample rate to the model's 16 kHz.
      SherpaOnnxOnlineStreamAcceptWaveform(stream, sampleRate, $0.baseAddress, Int32($0.count))
    }
    return decode()
  }

  func finish() -> String {
    // Pad the final encoder window before InputFinished so release never truncates the last word.
    let tail = [Float](repeating: 0, count: Int(inputSampleRate / 2))
    tail.withUnsafeBufferPointer {
      SherpaOnnxOnlineStreamAcceptWaveform(stream, inputSampleRate, $0.baseAddress, Int32($0.count))
    }
    SherpaOnnxOnlineStreamInputFinished(stream)
    return decode(resetEndpoint: false)
  }

  private func decode(resetEndpoint: Bool = true) -> String {
    while SherpaOnnxIsOnlineStreamReady(recognizer.handle, stream) != 0 {
      SherpaOnnxDecodeOnlineStream(recognizer.handle, stream)
    }
    guard let result = SherpaOnnxGetOnlineStreamResult(recognizer.handle, stream) else { return committed }
    let partial = result.pointee.text.map { String(cString: $0) } ?? ""
    SherpaOnnxDestroyOnlineRecognizerResult(result)
    let text = joinTranscript(committed, partial.trimmingCharacters(in: .whitespacesAndNewlines))
    if resetEndpoint && SherpaOnnxOnlineStreamIsEndpoint(recognizer.handle, stream) != 0 {
      committed = text
      SherpaOnnxOnlineStreamReset(recognizer.handle, stream)
    }
    return text
  }
}

func joinTranscript(_ committed: String, _ partial: String) -> String {
  guard let last = committed.last, let first = partial.first else { return committed + partial }
  let separator = last.isASCII && first.isASCII && (last.isLetter || last.isNumber)
    && (first.isLetter || first.isNumber) ? " " : ""
  return committed + separator + partial
}

struct SpeechFailure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
