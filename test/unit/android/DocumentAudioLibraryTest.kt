package top.izuna.foliamajor

import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.ProviderInfo
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import java.io.BufferedOutputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowContentResolver

// Exercise folder indexing and the actual audio response against a document provider, without a phone.
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28], application = Application::class)
class DocumentAudioLibraryTest {
    private lateinit var context: Context
    private lateinit var provider: MusicProvider
    private val authority = "folia.test.music"
    private val tree: Uri get() = DocumentsContract.buildTreeDocumentUri(authority, "root")

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        provider = MusicProvider()
        provider.attachInfo(context, ProviderInfo().apply { authority = this@DocumentAudioLibraryTest.authority })
        ShadowContentResolver.registerProviderInternal(authority, provider)
    }

    @Test
    fun indexesNestedFoldersWithoutOpeningOrCopyingAudio() {
        val result = DocumentAudioLibrary.importFolder(context, tree, 1234)
        val tracks = result.getJSONArray("tracks")
        assertEquals(2, tracks.length())
        assertEquals(0, result.getInt("copied"))
        assertEquals(0, provider.opens)
        assertFalse(File(context.filesDir, "imported-audio").exists())
        val first = tracks.getJSONObject(0).getString("id")
        val second = tracks.getJSONObject(1).getString("id")
        assertNotEquals(first, second)
        assertEquals(DocumentsContract.buildDocumentUriUsingTree(tree, "a"), DocumentAudioLibrary.resolve(context, first))
        assertTrue(File(context.applicationInfo.dataDir, "shared_prefs/document-audio-references.xml").isFile)
    }

    @Test
    fun reimportAndOverlappingFolderUseTheSameIdentity() {
        val first = DocumentAudioLibrary.importFolder(context, tree, 1234).getJSONArray("tracks")
        val again = DocumentAudioLibrary.importFolder(context, tree, 5678).getJSONArray("tracks")
        assertEquals(first.getJSONObject(0).getString("id"), again.getJSONObject(0).getString("id"))
        val album = DocumentsContract.buildTreeDocumentUri(authority, "album")
        val overlapping = DocumentAudioLibrary.importFolder(context, album, 5678).getJSONArray("tracks")
        assertEquals(first.getJSONObject(1).getString("id"), overlapping.getJSONObject(0).getString("id"))
        assertNull(DocumentAudioLibrary.resolve(context, "document-../../outside"))
    }

    @Test
    fun mediaDocumentIncludesItsExistingScanIdentity() {
        val mediaAuthority = "com.android.providers.media.documents"
        provider.firstId = "audio:41"
        ShadowContentResolver.registerProviderInternal(mediaAuthority, provider)
        val mediaTree = DocumentsContract.buildTreeDocumentUri(mediaAuthority, "root")
        val tracks = DocumentAudioLibrary.importFolder(context, mediaTree, 1234).getJSONArray("tracks")
        assertEquals("41", tracks.getJSONObject(0).getJSONArray("sourceRefs").getString(0))
        assertTrue(tracks.getJSONObject(0).getString("id").startsWith("document-"))
        assertEquals(0, provider.opens)
    }

    @Test
    fun emptySourcesAreReportedWithoutAddingUnplayableLibraryEntries() {
        provider.source.writeBytes(byteArrayOf())
        val result = DocumentAudioLibrary.importFolder(context, tree, 1234)
        assertEquals(0, result.getJSONArray("tracks").length())
        assertEquals(2, result.getJSONArray("failures").length())
        assertFalse(File(context.filesDir, "imported-audio").exists())
    }

    @Test
    fun newServerReadsCurrentSourceAndSupportsHeadAndRanges() {
        val ref = DocumentAudioLibrary.importFolder(context, tree, 1234)
            .getJSONArray("tracks").getJSONObject(0).getString("id")
        assertTrue(response(ref, "GET").endsWith("0123456789"))
        val head = response(ref, "HEAD")
        assertTrue(head.contains("Content-Length: 10\r\n"))
        assertEquals("", head.substringAfter("\r\n\r\n"))
        val range = response(ref, "GET", mapOf("range" to "bytes=3-6"))
        assertTrue(range.startsWith("HTTP/1.1 206"))
        assertTrue(range.contains("Content-Range: bytes 3-6/10\r\n"))
        assertEquals("3456", range.substringAfter("\r\n\r\n"))
        provider.source.writeText("abcdefghij")
        assertEquals("abcdefghij", response(ref, "GET").substringAfter("\r\n\r\n"))
        assertFalse(File(context.filesDir, "imported-audio").exists())
    }

    @Test
    fun lostPermissionOrMissingOriginalNeverFallsBackToACopy() {
        val ref = DocumentAudioLibrary.importFolder(context, tree, 1234)
            .getJSONArray("tracks").getJSONObject(0).getString("id")
        provider.readable = false
        assertTrue(response(ref, "GET").startsWith("HTTP/1.1 403"))
        provider.readable = true
        assertTrue(provider.source.delete())
        assertTrue(response(ref, "GET").startsWith("HTTP/1.1 404"))
        assertFalse(File(context.filesDir, "imported-audio").exists())
    }

    @Test
    @Config(shadows = [UnknownLengthDescriptorShadow::class])
    fun unknownLengthPipeStillSupportsHeadAndSeekingWithoutADiskCopy() {
        provider.unknownLength = true
        val imported = DocumentAudioLibrary.importFolder(context, tree, 1234)
        assertEquals(imported.getJSONArray("failures").toString(), 2, imported.getJSONArray("tracks").length())
        val ref = imported.getJSONArray("tracks").getJSONObject(0).getString("id")
        assertEquals(2, provider.opens)
        provider.opens = 0
        assertTrue(response(ref, "HEAD").contains("Content-Length: 10\r\n"))
        assertEquals(1, provider.opens)
        val range = response(ref, "GET", mapOf("range" to "bytes=3-6"))
        assertTrue(range.startsWith("HTTP/1.1 206"))
        assertEquals("3456", range.substringAfter("\r\n\r\n"))
        assertEquals(2, provider.opens)
        provider.source.writeText("longer original content")
        provider.modified++
        val updated = response(ref, "HEAD")
        assertTrue(updated.contains("Content-Length: ${provider.source.length()}\r\n"))
        assertEquals(4, provider.opens)
        response(ref, "GET", mapOf("range" to "bytes=3-6"))
        assertEquals(5, provider.opens)
        assertFalse(File(context.filesDir, "imported-audio").exists())
    }

    @Test
    fun nonSeekableSourcesCanStillReadFromTheRequestedOffset() {
        val input = object : ByteArrayInputStream("0123456789".toByteArray()) {
            override fun skip(bytes: Long): Long = throw IOException("Illegal seek")
        }
        val factory = LocalAudioServer::class.java.getDeclaredMethod("documentInputStream", InputStream::class.java)
            .apply { isAccessible = true }
        (factory.invoke(LocalAudioServer(context), input) as InputStream).use { stream ->
            assertEquals(3L, stream.skip(3))
            assertEquals("3456789", stream.readBytes().toString(Charsets.US_ASCII))
        }
    }

    // Robolectric backs pipes with regular files; expose the unknown length returned by real pipes.
    @Implements(AssetFileDescriptor::class)
    class UnknownLengthDescriptorShadow {
        @Implementation
        fun getLength(): Long = AssetFileDescriptor.UNKNOWN_LENGTH
    }

    // Invoke the real response writer directly; no listening socket or executor threads outlive a test.
    private fun response(ref: String, method: String, headers: Map<String, String> = emptyMap()): String {
        val bytes = ByteArrayOutputStream()
        val writer = LocalAudioServer::class.java.getDeclaredMethod(
            "streamDocumentFile", BufferedOutputStream::class.java, Array<String>::class.java,
            Map::class.java, String::class.java,
        ).apply { isAccessible = true }
        BufferedOutputStream(bytes).use { output ->
            writer.invoke(LocalAudioServer(context), output, arrayOf(method, "/audio/$ref", "HTTP/1.1"), headers, ref)
        }
        return bytes.toString(Charsets.US_ASCII.name())
    }

    class MusicProvider : ContentProvider() {
        lateinit var source: File
        var opens = 0
        var readable = true
        var unknownLength = false
        var firstId = "a"
        var modified = 1234L

        override fun onCreate(): Boolean {
            source = File(context!!.cacheDir, "original-song.mp3").apply { writeText("0123456789") }
            return true
        }

        override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor {
            if (!readable) throw SecurityException("Permission revoked")
            val columns = projection ?: emptyArray()
            val cursor = MatrixCursor(columns)
            fun add(id: String, name: String, mime: String) {
                val values = mapOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID to id,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME to name,
                    DocumentsContract.Document.COLUMN_MIME_TYPE to mime,
                    DocumentsContract.Document.COLUMN_SIZE to if (unknownLength) null else source.length(),
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED to modified,
                )
                cursor.addRow(columns.map { values[it] })
            }
            if (uri.lastPathSegment == "children") {
                when (DocumentsContract.getDocumentId(uri)) {
                    "root" -> {
                        add("album", "Album", DocumentsContract.Document.MIME_TYPE_DIR)
                        add(firstId, "song.mp3", "audio/mpeg")
                        add("notes", "notes.txt", "text/plain")
                    }
                    "album" -> add("b", "song.mp3", "audio/mpeg")
                }
            } else {
                add(DocumentsContract.getDocumentId(uri), "song.mp3", "audio/mpeg")
            }
            return cursor
        }

        override fun openAssetFile(uri: Uri, mode: String): AssetFileDescriptor {
            if (!readable) throw SecurityException("Permission revoked")
            if (!source.exists()) throw FileNotFoundException()
            check(mode == "r")
            opens++
            if (unknownLength) {
                val pipe = ParcelFileDescriptor.createPipe()
                ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use { it.write(source.readBytes()) }
                return AssetFileDescriptor(pipe[0], 0, AssetFileDescriptor.UNKNOWN_LENGTH)
            }
            return AssetFileDescriptor(ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_ONLY), 0, source.length())
        }

        override fun getType(uri: Uri) = "audio/mpeg"
        override fun insert(uri: Uri, values: ContentValues?): Uri? = error("Read-only provider")
        override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = error("Must not delete original music")
        override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = error("Must not modify original music")
    }
}
