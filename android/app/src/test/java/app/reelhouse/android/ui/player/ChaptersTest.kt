package app.reelhouse.android.ui.player

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.playback.Chapter
import app.reelhouse.android.data.playback.PlaybackInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The player's chapter buttons, as the web player has them (web/js/chapters.js and test/chapters.test.js). */
class ChaptersTest {
    private val film = usableChapters(
        listOf(
            Chapter(75.0, 120.0, "Part Two"), // out of order in the list: put right
            Chapter(0.0, 30.0, "Opening"),
            Chapter(30.0, 75.0, "Part One"),
            Chapter(120.0, 160.0, "Chapter 04"),
        ),
    )

    @Test
    fun `chapters come in order, and one chapter alone is no chapters`() {
        assertEquals(listOf(0.0, 30.0, 75.0, 120.0), film.map { it.start })
        assertTrue(usableChapters(listOf(Chapter(0.0, 100.0, "Movie"))).isEmpty())
        assertTrue(usableChapters(null).isEmpty())
        assertTrue(usableChapters(listOf(Chapter(0.0), Chapter(Double.NaN))).isEmpty())
    }

    @Test
    fun `next goes to the start of the following chapter, and nowhere from the last`() {
        assertEquals(ChapterTarget(1, 30.0), nextChapter(film, 10.0))
        assertEquals(ChapterTarget(1, 30.0), nextChapter(film, 29.0))
        // Just landed on a chapter's start (a little before or after it): on to the one after, not the same again.
        assertEquals(ChapterTarget(2, 75.0), nextChapter(film, 29.7))
        assertEquals(ChapterTarget(2, 75.0), nextChapter(film, 30.2))
        assertNull(nextChapter(film, 130.0))
    }

    @Test
    fun `previous goes to the start of this chapter, or the one before when it has only just begun`() {
        assertEquals(ChapterTarget(1, 30.0), previousChapter(film, 50.0))
        assertEquals(ChapterTarget(0, 0.0), previousChapter(film, 31.0)) // 1 s in: the chapter before
        assertEquals(ChapterTarget(0, 0.0), previousChapter(film, 29.8)) // landed a moment early
        assertEquals(ChapterTarget(0, 0.0), previousChapter(film, 2.0)) // the first: its start
        // A film whose first chapter starts late: before it, back to the very start.
        assertEquals(ChapterTarget(0, 0.0), previousChapter(usableChapters(listOf(Chapter(20.0), Chapter(60.0))), 5.0))
        assertEquals(2, chapterIndex(film, 76.0))
    }

    @Test
    fun `a chapter is named by its title, unless the title only repeats the number or a time`() {
        assertEquals("Part One", chapterTitle(Chapter(30.0, title = "Part One")))
        for (plain in listOf("Chapter 04", "Chapter 4", "Chapitre 12", "7", "00:05:12.000", "1:02:03", "", null)) {
            assertNull(plain, chapterTitle(Chapter(0.0, title = plain)))
        }
        assertEquals("Chapter 2 of 4 · Part One", chapterLabel(film, 1))
        assertEquals("Chapter 4 of 4", chapterLabel(film, 3))
    }

    @Test
    fun `the playback answer brings the chapters, and older servers none`() {
        val json = """{"playId":"p","mode":"direct","url":"/x","chapters":[{"start":0,"end":30.5,"title":"Opening"},{"start":30.5,"end":60,"title":null}]}"""
        val info = AppJson.decodeFromString(PlaybackInfo.serializer(), json)
        assertEquals(listOf(Chapter(0.0, 30.5, "Opening"), Chapter(30.5, 60.0, null)), info.chapters)
        val older = AppJson.decodeFromString(PlaybackInfo.serializer(), """{"playId":"p","mode":"direct","url":"/x"}""")
        assertTrue(older.chapters.isEmpty())
    }
}
