package expo.modules.hermesspeech

import org.junit.Assert.assertEquals
import org.junit.Test

class TranscriptTextTest {
  @Test fun cumulativePartialsReplaceWithoutDuplicatingChinese() {
    val text = TranscriptText()
    assertEquals("你好", text.update("你好", false))
    assertEquals("你好世界", text.update("你好世界", true))
    assertEquals("你好世界再见", text.update("再见", false))
    assertEquals("你好世界再见", text.update("再见", true))
    assertEquals("你好世界再见", text.update("", false))
  }

  @Test fun endpointsKeepEnglishWordBoundariesAndTrimPadding() {
    val text = TranscriptText()
    assertEquals("hello", text.update("  hello ", true))
    assertEquals("hello world", text.update("world  ", true))
    assertEquals("hello world你好", text.update("你好", false))
  }
}
