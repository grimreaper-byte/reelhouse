package app.reelhouse.android.ui.settings

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/**
 * What a picture for your account must be, checked on the phone before it's uploaded (Reelhouse checks and redraws
 * it again). The phone decodes HEIC photos itself and sends a JPEG, so those work here too.
 */
object AvatarRules {
    const val MAX_BYTES = 15L * 1024 * 1024 // as the server
    const val MIN_SIDE = 64
    const val UPLOAD_SIDE = 512
    val TYPES = setOf("image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif")

    // The messages say "That picture": the photo picker doesn't pass on file names (it calls them e.g. "34.png").

    /** Why a file can't be used as it is (its type and size; null = unknown, left to the decoder), or null. */
    fun fileProblem(type: String?, bytes: Long?): String? = when {
        type != null && type !in TYPES -> "That isn’t a JPEG, PNG, WebP, GIF or HEIC picture."
        bytes != null && bytes == 0L -> "That picture is empty."
        bytes != null && bytes > MAX_BYTES -> "That picture is %.1f MB; pictures can be up to 15 MB.".format(bytes / 1048576.0)
        else -> null
    }

    /** Why a picture of this size can't be used, or null. */
    fun sizeProblem(width: Int, height: Int): String? = when {
        width <= 0 || height <= 0 -> UNREADABLE
        width < MIN_SIDE || height < MIN_SIDE -> "That picture is only $width×$height. Choose one at least $MIN_SIDE pixels each way."
        else -> null
    }

    const val UNREADABLE = "That picture couldn’t be opened. It may be damaged."

    /** The middle square of a width × height picture: x, y and side. */
    fun middleSquare(width: Int, height: Int): Triple<Int, Int, Int> {
        val side = minOf(width, height)
        return Triple((width - side) / 2, (height - side) / 2, side)
    }

    /** How much to shrink while decoding so the short side stays at least [UPLOAD_SIDE] (a power of two). */
    fun sampleSize(width: Int, height: Int): Int {
        var n = 1
        while (minOf(width, height) / (n * 2) >= UPLOAD_SIDE) n *= 2
        return n
    }
}

class AvatarProblem(message: String) : Exception(message)

/** A checked picture, ready to upload: [jpeg] is the square that [preview] shows. */
class PreparedAvatar(val width: Int, val height: Int, val bytes: Long?, val preview: Bitmap, val jpeg: ByteArray)

/** Checks the picture at [uri] and makes the square JPEG to upload; throws [AvatarProblem] with a reason. */
suspend fun prepareAvatar(context: Context, uri: Uri, background: Int): PreparedAvatar = withContext(Dispatchers.IO) {
    val resolver = context.contentResolver
    var bytes: Long? = null
    runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) bytes = c.getLong(0)
        }
    }
    AvatarRules.fileProblem(resolver.getType(uri), bytes)?.let { throw AvatarProblem(it) }

    var width = 0
    var height = 0
    val decoded: Bitmap = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Turns phone photos upright from their rotation tag, and opens HEIC.
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
                width = info.size.width
                height = info.size.height
                decoder.setTargetSampleSize(AvatarRules.sampleSize(width, height))
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }.also { AvatarRules.sizeProblem(width, height)?.let { throw AvatarProblem(it) } }
        } else {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            width = bounds.outWidth
            height = bounds.outHeight
            AvatarRules.sizeProblem(width, height)?.let { throw AvatarProblem(it) }
            val bitmap = resolver.openInputStream(uri)?.use {
                BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = AvatarRules.sampleSize(width, height) })
            } ?: throw AvatarProblem(AvatarRules.UNREADABLE)
            upright(bitmap, resolver.openInputStream(uri)?.use { runCatching { ExifInterface(it).rotationDegrees }.getOrDefault(0) } ?: 0)
        }
    } catch (e: AvatarProblem) {
        throw e
    } catch (e: Exception) {
        throw AvatarProblem(AvatarRules.UNREADABLE)
    }

    val (x, y, side) = AvatarRules.middleSquare(decoded.width, decoded.height)
    val out = minOf(AvatarRules.UPLOAD_SIDE, side)
    val square = Bitmap.createBitmap(out, out, Bitmap.Config.ARGB_8888)
    Canvas(square).apply {
        drawColor(background) // transparent parts get the app's colour rather than JPEG's black
        drawBitmap(decoded, android.graphics.Rect(x, y, x + side, y + side), android.graphics.Rect(0, 0, out, out), android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG))
    }
    if (square !== decoded) decoded.recycle()
    val jpeg = ByteArrayOutputStream().use { s ->
        square.compress(Bitmap.CompressFormat.JPEG, 90, s)
        s.toByteArray()
    }
    PreparedAvatar(width, height, bytes, square, jpeg)
}

private val ExifInterface.rotationDegrees: Int
    get() = when (getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90
        ExifInterface.ORIENTATION_ROTATE_180 -> 180
        ExifInterface.ORIENTATION_ROTATE_270 -> 270
        else -> 0
    }

private fun upright(bitmap: Bitmap, degrees: Int): Bitmap {
    if (degrees == 0) return bitmap
    val turned = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(degrees.toFloat()) }, true)
    if (turned !== bitmap) bitmap.recycle()
    return turned
}
