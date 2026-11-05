package app.reelhouse.android.ui.person

import app.reelhouse.android.data.AppJson
import app.reelhouse.android.data.model.PersonInfo
import app.reelhouse.android.data.model.PersonPage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Locale

class PersonFactsTest {
    private fun item(type: String) = app.reelhouse.android.data.model.Item(id = 1, type = type, title = "x")

    @Test
    fun `the count says what is on the server`() {
        assertEquals("2 movies on this server", hereLine(listOf(item("movie"), item("movie"))))
        assertEquals("1 movie on this server", hereLine(listOf(item("movie"))))
        assertEquals("1 movie and 2 shows on this server", hereLine(listOf(item("movie"), item("show"), item("show"))))
        assertEquals("1 show on this server", hereLine(listOf(item("show"))))
        assertEquals("No movies on this server", hereLine(emptyList()))
    }

    @Test
    fun `someone alive gets their age, someone who has died their age at death`() {
        assertEquals(
            listOf("Born 30 May 1971 (age 55)", "in Queens, New York, USA"),
            factLines(PersonInfo(birthday = "1971-05-30", birthplace = "Queens, New York, USA", age = 55), Locale.UK),
        )
        assertEquals(
            listOf("Born 21 Jul 1951", "in Chicago, Illinois, USA", "Died 11 Aug 2014 (aged 63)"),
            factLines(PersonInfo(birthday = "1951-07-21", deathday = "2014-08-11", birthplace = "Chicago, Illinois, USA", age = 63), Locale.UK),
        )
    }

    @Test
    fun `only what is known, and an unreadable date as it came`() {
        assertEquals(listOf("Born in Leeds, England, UK"), factLines(PersonInfo(birthplace = "Leeds, England, UK"), Locale.UK))
        assertEquals(listOf("Born 1971"), factLines(PersonInfo(birthday = "1971"), Locale.UK))
        assertEquals(emptyList<String>(), factLines(PersonInfo(biography = "Just a biography."), Locale.UK))
    }

    @Test
    fun `a page from a server without TMDB has no info, and older servers' pages still read`() {
        val page = AppJson.decodeFromString(PersonPage.serializer(), """{"name":"Idina Menzel","items":[],"others":{"status":"off","items":[]}}""")
        assertNull(page.info)
        assertEquals("off", page.others.status)
    }
}
