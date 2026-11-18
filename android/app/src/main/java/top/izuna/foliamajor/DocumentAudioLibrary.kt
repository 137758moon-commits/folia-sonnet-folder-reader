package top.izuna.foliamajor

import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import java.io.IOException
import java.io.File
import java.security.MessageDigest
import java.util.ArrayDeque

// Folder imports retain document references. The provider continues to own every audio file.
object DocumentAudioLibrary {
    const val REF_PREFIX = "document-"
    private const val PREFERENCES = "document-audio-references"
    private val referencePattern = Regex("document-[0-9a-f]{64}")

    fun reference(authority: String, documentId: String): String {
        val identity = (authority + "\n" + documentId).toByteArray(Charsets.UTF_8)
        val digest = MessageDigest.getInstance("SHA-256").digest(identity)
        return REF_PREFIX + digest.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    fun resolve(context: Context, reference: String): Uri? {
        if (!referencePattern.matches(reference)) return null
        val stored = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getString(reference, null) ?: return null
        return Uri.parse(stored).takeIf { it.scheme == "content" }
    }

    fun cachedSize(context: Context, reference: String, modified: Long): Long? {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        if (modified > 0 && preferences.getLong("$reference.modified", 0) != modified) return null
        return preferences.getLong("$reference.size", -1).takeIf { it >= 0 }
    }

    fun rememberSize(context: Context, reference: String, size: Long, modified: Long) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
            .putLong("$reference.size", size).putLong("$reference.modified", modified).apply()
    }

    // Count only providers that omit SIZE; retain the count, never the audio bytes.
    private fun measureSize(context: Context, uri: Uri): Long {
        val descriptor = context.contentResolver.openAssetFileDescriptor(uri, "r")
            ?: throw IOException("Cannot open audio document")
        descriptor.use { asset ->
            if (asset.length >= 0) return asset.length
            asset.createInputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                var count: Int
                while (input.read(buffer).also { count = it } != -1) total += count
                return total
            }
        }
    }

    // Match a previous device scan by provider identity, never by a coincidentally equal name and size.
    private fun scannedAudioRefs(context: Context, uri: Uri): List<String> {
        if (uri.authority != "com.android.externalstorage.documents"
            && uri.authority != "com.android.providers.media.documents") return emptyList()
        val refs = mutableListOf<String>()
        try {
            val id = DocumentsContract.getDocumentId(uri)
            val path = if (uri.authority == "com.android.externalstorage.documents" && id.startsWith("primary:"))
                File(Environment.getExternalStorageDirectory(), id.substringAfter(':')).absolutePath else null
            if (path != null) refs.add("file-$path")
            if (uri.authority == "com.android.providers.media.documents" && id.startsWith("audio:")) {
                id.substringAfter(':').takeIf { it.toLongOrNull() != null }?.let { refs.add(it) }
            }
            if (Build.VERSION.SDK_INT >= 29) {
                val media = MediaStore.getMediaUri(context, uri)
                media?.lastPathSegment?.takeIf { it.toLongOrNull() != null }?.let { refs.add(it) }
            } else if (path != null) {
                context.contentResolver.query(
                    MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                    arrayOf(MediaStore.Audio.Media._ID), "${MediaStore.Audio.Media.DATA} = ?", arrayOf(path), null
                )?.use { cursor ->
                    if (cursor.moveToFirst()) refs.add(cursor.getLong(0).toString())
                }
            }
        } catch (_: Exception) {
            // No MediaStore permission/index is needed to import a folder through its own grant.
        }
        return refs
    }

    fun importFolder(context: Context, tree: Uri, port: Int): JSObject {
        val resolver = context.contentResolver
        val authority = tree.authority ?: throw IOException("Missing document provider")
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val pending = ArrayDeque<String>()
        val visited = HashSet<String>()
        val tracks = JSArray()
        val failures = JSArray()
        val references = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        pending.add(rootId)
        while (pending.isNotEmpty()) {
            val parent = pending.removeFirst()
            if (!visited.add(parent)) continue
            try {
                val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
                resolver.query(children, projection, null, null, null).use { cursor ->
                    if (cursor == null) throw IOException("Cannot read selected directory")
                    while (cursor.moveToNext()) {
                        val documentId = cursor.getString(0) ?: continue
                        val name = cursor.getString(1) ?: continue
                        val mime = cursor.getString(2).orEmpty()
                        if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                            pending.add(documentId)
                        } else if (LocalAudioServer.isAudioFileName(name) || mime.startsWith("audio/")) {
                            val uri = DocumentsContract.buildDocumentUriUsingTree(tree, documentId)
                            val ref = reference(authority, documentId)
                            val size = try {
                                if (cursor.isNull(3) || cursor.getLong(3) <= 0) measureSize(context, uri) else cursor.getLong(3)
                            } catch (error: Exception) {
                                failures.put(JSObject().apply {
                                    put("uri", uri.toString())
                                    put("message", error.message ?: error.toString())
                                })
                                continue
                            }
                            if (size == 0L) {
                                failures.put(JSObject().apply {
                                    put("uri", uri.toString())
                                    put("message", "Empty audio document")
                                })
                                continue
                            }
                            val modified = if (cursor.isNull(4)) 0L else cursor.getLong(4)
                            references.putString(ref, uri.toString())
                            references.putLong("$ref.size", size).putLong("$ref.modified", modified)
                            tracks.put(JSObject().apply {
                                put("id", ref)
                                put("sourceRefs", JSArray(scannedAudioRefs(context, uri)))
                                put("fileName", name)
                                put("fileSize", size)
                                put("mimeType", if (mime.startsWith("audio/")) mime else LocalAudioServer.guessMimeType(name))
                                put("url", "http://127.0.0.1:$port/audio/$ref")
                            })
                        }
                    }
                }
            } catch (error: Exception) {
                if (parent == rootId) throw error
                failures.put(JSObject().apply {
                    put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, parent).toString())
                    put("message", error.message ?: error.toString())
                })
            }
        }
        if (!references.commit()) throw IOException("Could not save folder references")
        return JSObject().apply {
            put("tracks", tracks)
            put("port", port)
            put("picked", tracks.length())
            put("copied", 0)
            put("failures", failures)
            put("resultCode", android.app.Activity.RESULT_OK)
        }
    }
}
