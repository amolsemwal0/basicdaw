package com.basicdaw.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.IOException;
import java.io.OutputStream;

/** Saves exports to the shared Download folder. basicdaw_android.py calls it for the server's /api/exports. */
public final class Downloads {
    static final String FOLDER = Environment.DIRECTORY_DOWNLOADS + "/BasicDAW";

    private Downloads() {
    }

    /** Writes the file through MediaStore (no storage permission needed) and returns where it went. */
    public static String save(Context context, String name, String mime, byte[] data) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("Could not create " + name + " in " + FOLDER);
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new IOException("Could not write " + name);
            out.write(data);
        } catch (IOException e) {
            resolver.delete(uri, null, null);
            throw e;
        }
        values.clear();
        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(uri, values, null, null);

        String saved = name; // MediaStore renames instead of overwriting: "Song (1).mp3"
        try (Cursor c = resolver.query(uri, new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) saved = c.getString(0);
        }
        return FOLDER + "/" + saved;
    }
}
