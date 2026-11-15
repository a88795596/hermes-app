import Foundation
import SherpaOnnxC

@main
struct RecognizerCheck {
  static func main() throws {
    precondition(CommandLine.arguments.count == 3, "Pass model directory and official test_wavs/0.wav")
    let recognizer = try StreamingRecognizer(directory: URL(fileURLWithPath: CommandLine.arguments[1]))
    let empty = try recognizer.makeStream()
    precondition(empty.finish().isEmpty, "An empty recording invented text")
    guard let wave = SherpaOnnxReadWave(CommandLine.arguments[2]) else { fatalError("Cannot read test WAV") }
    defer { SherpaOnnxFreeWave(wave) }
    let samples = Array(UnsafeBufferPointer(start: wave.pointee.samples, count: Int(wave.pointee.num_samples)))
    let sampleRate = wave.pointee.sample_rate
    let transcript = try recognizer.makeStream()
    var updates: [String] = []
    func feed(_ samples: [Float], rate: Int32) {
      for offset in stride(from: 0, to: samples.count, by: Int(rate) / 10) {
        let end = min(offset + Int(rate) / 10, samples.count)
        updates.append(transcript.accept(Array(samples[offset..<end]), sampleRate: rate))
      }
    }
    feed(samples, rate: sampleRate)
    feed([Float](repeating: 0, count: Int(sampleRate) * 3), rate: sampleRate)
    let first = updates.last!
    let expected = "对我做了介绍啊那么我想说的是呢大家如果对我的研究感兴趣呢"
    precondition(first.replacingOccurrences(of: " ", with: "") == expected, "Unexpected Chinese result: \(first)")
    precondition(updates.contains { !$0.isEmpty && $0 != first }, "No incremental transcription")
    feed(samples, rate: sampleRate)
    let final = transcript.finish()
    precondition(final == joinTranscript(first, first), "Endpoint duplicated or lost words: \(final)")
    // Exercise hardware-rate input and stop padding with the same C resampler used by the microphone.
    let resampled = try recognizer.makeStream()
    let hardwareSamples = samples.flatMap { [ $0, $0, $0 ] }
    for offset in stride(from: 0, to: hardwareSamples.count, by: 4_800) {
      _ = resampled.accept(Array(hardwareSamples[offset..<min(offset + 4_800, hardwareSamples.count)]), sampleRate: sampleRate * 3)
    }
    precondition(resampled.finish().replacingOccurrences(of: " ", with: "") == expected, "Hardware-rate resampling lost speech")
    print("Chinese streaming, endpoint accumulation, final flush, and resampling passed: \(first)")
  }
}
