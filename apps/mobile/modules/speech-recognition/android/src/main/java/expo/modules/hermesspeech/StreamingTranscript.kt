package expo.modules.hermesspeech

import com.k2fsa.sherpa.onnx.OnlineRecognizer

// The recognizer and stream are confined to the inference executor.
internal class StreamingTranscript(private val recognizer: OnlineRecognizer) {
  private val stream = recognizer.createStream()
  private val text = TranscriptText()
  private var sampleRate = 16_000

  fun accept(samples: FloatArray, rate: Int): String {
    sampleRate = rate
    stream.acceptWaveform(samples, rate)
    return decode(true)
  }

  fun finish(): String {
    // Pad the final encoder window before InputFinished to retain the last word.
    stream.acceptWaveform(FloatArray(sampleRate / 2), sampleRate)
    stream.inputFinished()
    return decode(false)
  }

  private fun decode(resetEndpoint: Boolean): String {
    while (recognizer.isReady(stream)) recognizer.decode(stream)
    val endpoint = resetEndpoint && recognizer.isEndpoint(stream)
    val result = text.update(recognizer.getResult(stream).text, endpoint)
    if (endpoint) recognizer.reset(stream)
    return result
  }

  fun release() = stream.release()
}
