package com.basicdaw.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;

import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

/**
 * Runs BasicDAW's server (server.py, via basicdaw_android.py) inside the app and shows the DAW in a WebView,
 * the same web app the desktop versions show.
 */
public class MainActivity extends Activity {
    private static final String TAG = "BasicDAW";
    private static final int PORT = 8790; // fixed, so the page's origin (and its saved preferences) stays the same
    private static final int PICK_FILES = 1;
    private static final String STARTING = "<body style='margin:0;height:100vh;display:grid;place-items:center;"
            + "background:#0b0d18;color:#9096b8;font:16px sans-serif'>Starting BasicDAW…</body>";
    // Back closes an open menu or dialog (as Escape does); otherwise the app goes to the background.
    private static final String BACK_JS = "(() => { if (!document.querySelector('#menu-root .menu, #modal-root .modal-backdrop'))"
            + " return false; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));"
            + " return true; })()";
    private static final String SAVE_JS = "window.basicdaw && basicdaw.store.dirty && basicdaw.saveProject({ quiet: true })";

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (!Python.isStarted()) Python.start(new AndroidPlatform(this));

        web = new WebView(this);
        web.setBackgroundColor(0xff0b0d18);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);      // honour the page's viewport (phones get a scaled tablet layout)
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setAllowFileAccess(false);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if ("127.0.0.1".equals(url.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url)); // other sites open in the browser
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT)
                        .setType("*/*")
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(pick, null), PICK_FILES);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        }

        web.loadDataWithBaseURL(null, STARTING, "text/html", "utf-8", null);
        new Thread(() -> {
            try {
                int port = Python.getInstance().getModule("basicdaw_android")
                        .callAttr("start", getApplicationContext(), PORT).toInt();
                runOnUiThread(() -> web.loadUrl("http://127.0.0.1:" + port + "/"));
            } catch (Exception e) {
                Log.e(TAG, "server did not start", e);
                String msg = String.valueOf(e.getMessage()).replace("<", "&lt;");
                runOnUiThread(() -> web.loadDataWithBaseURL(null, STARTING.replace("Starting BasicDAW…",
                        "BasicDAW could not start: " + msg), "text/html", "utf-8", null));
            }
        }, "basicdaw-start").start();
    }

    private void back() {
        web.evaluateJavascript(BACK_JS, (handled) -> {
            if (!"true".equals(handled)) moveTaskToBack(true);
        });
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() { // Android 12 and older
        back();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILES || fileCallback == null) return;
        Uri[] picked = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                picked = new Uri[clip.getItemCount()];
                for (int i = 0; i < picked.length; i++) picked[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                picked = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(picked);
        fileCallback = null;
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.evaluateJavascript(SAVE_JS, null); // Android may close a background app without asking
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    /** Full screen for the DAW; a swipe from the edge shows the bars for a moment. */
    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c == null) return;
            c.hide(WindowInsets.Type.systemBars());
            c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }
}
