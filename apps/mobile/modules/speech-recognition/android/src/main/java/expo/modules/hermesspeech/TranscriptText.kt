package expo.modules.hermesspeech

internal class TranscriptText {
  private var committed = ""

  fun update(partial: String, endpoint: Boolean): String {
    val next = partial.trim()
    val last = committed.lastOrNull()
    val first = next.firstOrNull()
    val space = last != null && first != null && last.code < 128 && first.code < 128
      && last.isLetterOrDigit() && first.isLetterOrDigit()
    val text = committed + (if (space) " " else "") + next
    if (endpoint) committed = text
    return text
  }
}
