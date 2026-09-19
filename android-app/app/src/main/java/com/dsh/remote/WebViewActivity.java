package com.dsh.remote;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebViewDatabase;
import android.widget.Button;
import android.widget.EditText;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * Compatibility mode: the original WebView shell around whatever the desktop
 * exposes (mirrored GUI or the gateway panel). Kept as a fallback for features
 * the native UI does not cover yet; opened from Settings.
 */
public class WebViewActivity extends AppCompatActivity {

    private static final String PREFS = "dsh_remote_webview";
    private static final String KEY_LAST_URL = "last_url";
    private static final String KEY_RECENT = "recent_urls";
    private static final String KEY_KEEP_ON = "keep_screen_on";
    private static final String APP_UA_SUFFIX = " DSHRemote/0.2";
    private static final int MAX_RECENT = 5;

    private static final int COLOR_IDLE = Color.parseColor("#FF9AA0A6");
    private static final int COLOR_BUSY = Color.parseColor("#FFE0B341");
    private static final int COLOR_OK = Color.parseColor("#FF3FB950");
    private static final int COLOR_FAIL = Color.parseColor("#FFE5534B");

    private WebView webView;
    private EditText urlInput;
    private ProgressBar progress;
    private SwipeRefreshLayout swipe;
    private View errorView;
    private TextView errorDetail;
    private View statusDot;
    private SharedPreferences prefs;

    private final ActivityResultLauncher<ScanOptions> scanLauncher =
            registerForActivityResult(new ScanContract(), result -> {
                if (result != null && result.getContents() != null) {
                    connect(normalize(result.getContents()));
                }
            });

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        webView = findViewById(R.id.webView);
        urlInput = findViewById(R.id.urlInput);
        progress = findViewById(R.id.progress);
        swipe = findViewById(R.id.swipe);
        errorView = findViewById(R.id.errorView);
        errorDetail = findViewById(R.id.errorDetail);
        statusDot = findViewById(R.id.statusDot);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setUserAgentString(settings.getUserAgentString() + APP_UA_SUFFIX);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                setStatus(COLOR_BUSY);
                errorView.setVisibility(View.GONE);
                progress.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                swipe.setRefreshing(false);
                progress.setVisibility(View.GONE);
                setStatus(COLOR_OK);
                if (url != null && !url.startsWith("about:")) {
                    urlInput.setText(url);
                    rememberUrl(url);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && !request.isForMainFrame()) {
                    return;
                }
                swipe.setRefreshing(false);
                progress.setVisibility(View.GONE);
                setStatus(COLOR_FAIL);
                errorView.setVisibility(View.VISIBLE);
                errorDetail.setText(error == null ? "" : String.valueOf(error.getDescription()));
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }
        });

        swipe.setOnRefreshListener(() -> webView.reload());

        Button btnConnect = findViewById(R.id.btnConnect);
        Button btnRefresh = findViewById(R.id.btnRefresh);
        Button btnScan = findViewById(R.id.btnScan);
        Button btnMore = findViewById(R.id.btnMore);
        Button btnRetry = findViewById(R.id.btnRetry);

        btnConnect.setOnClickListener(v -> connect(normalize(urlInput.getText().toString())));
        btnRefresh.setOnClickListener(v -> webView.reload());
        btnScan.setOnClickListener(v -> startScan());
        btnRetry.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            webView.reload();
        });
        btnMore.setOnClickListener(this::showMoreMenu);
        urlInput.setOnLongClickListener(v -> {
            showRecent();
            return true;
        });

        urlInput.setOnEditorActionListener((v, actionId, event) -> {
            boolean isGo = actionId == EditorInfo.IME_ACTION_GO
                    || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER);
            if (isGo) {
                connect(normalize(urlInput.getText().toString()));
                return true;
            }
            return false;
        });

        applyKeepScreenOn();

        String last = prefs.getString(KEY_LAST_URL, null);
        if (!TextUtils.isEmpty(last)) {
            urlInput.setText(last);
            webView.loadUrl(last);
        } else {
            setStatus(COLOR_IDLE);
            Toast.makeText(this, R.string.need_url, Toast.LENGTH_LONG).show();
        }

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        }
    }

    private void connect(String url) {
        if (TextUtils.isEmpty(url)) {
            Toast.makeText(this, R.string.need_url, Toast.LENGTH_SHORT).show();
            return;
        }
        urlInput.setText(url);
        urlInput.clearFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) {
            imm.hideSoftInputFromWindow(urlInput.getWindowToken(), 0);
        }
        webView.loadUrl(url);
    }

    /** Add a scheme when missing; LAN/local addresses default to http. */
    static String normalize(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            return value;
        }
        if (value.matches("^[a-zA-Z][a-zA-Z0-9+.\\-]*://.*")) {
            return value;
        }
        boolean local = value.startsWith("192.168.")
                || value.startsWith("10.")
                || value.startsWith("127.")
                || value.startsWith("172.")
                || value.startsWith("localhost")
                || value.contains(":3080");
        return (local ? "http://" : "https://") + value;
    }

    private void startScan() {
        ScanOptions options = new ScanOptions();
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
        options.setPrompt(getString(R.string.scan_prompt));
        options.setBeepEnabled(false);
        options.setOrientationLocked(false);
        scanLauncher.launch(options);
    }

    private void showMoreMenu(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add(0, 1, 0, R.string.menu_recent);
        menu.getMenu().add(0, 2, 1, R.string.menu_open_browser);
        menu.getMenu().add(0, 3, 2, R.string.menu_keep_screen_on).setCheckable(true)
                .setChecked(prefs.getBoolean(KEY_KEEP_ON, true));
        menu.getMenu().add(0, 4, 3, R.string.menu_reset);
        menu.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case 1:
                    showRecent();
                    return true;
                case 2:
                    String url = webView.getUrl();
                    if (url != null) {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    }
                    return true;
                case 3:
                    prefs.edit().putBoolean(KEY_KEEP_ON, !item.isChecked()).apply();
                    applyKeepScreenOn();
                    return true;
                case 4:
                    confirmReset();
                    return true;
                default:
                    return false;
            }
        });
        menu.show();
    }

    private void applyKeepScreenOn() {
        webView.setKeepScreenOn(prefs.getBoolean(KEY_KEEP_ON, true));
    }

    private void setStatus(int color) {
        statusDot.getBackground().setTint(color);
    }

    private List<String> recentUrls() {
        String raw = prefs.getString(KEY_RECENT, "");
        if (TextUtils.isEmpty(raw)) {
            return new ArrayList<>();
        }
        return new ArrayList<>(Arrays.asList(raw.split("\n")));
    }

    private void rememberUrl(String url) {
        LinkedHashSet<String> set = new LinkedHashSet<>();
        set.add(url);
        for (String entry : recentUrls()) {
            if (set.size() >= MAX_RECENT) {
                break;
            }
            set.add(entry);
        }
        prefs.edit()
                .putString(KEY_LAST_URL, url)
                .putString(KEY_RECENT, TextUtils.join("\n", set))
                .apply();
    }

    private void showRecent() {
        final List<String> urls = recentUrls();
        if (urls.isEmpty()) {
            Toast.makeText(this, R.string.need_url, Toast.LENGTH_SHORT).show();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.recent_title)
                .setItems(urls.toArray(new String[0]), (dialog, which) -> connect(urls.get(which)))
                .show();
    }

    private void confirmReset() {
        new AlertDialog.Builder(this)
                .setMessage(R.string.reset_confirm)
                .setPositiveButton(android.R.string.ok, (dialog, which) -> resetCredential())
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private void resetCredential() {
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        WebStorage.getInstance().deleteAllData();
        WebViewDatabase.getInstance(this).clearFormData();
        webView.clearCache(true);
        webView.clearHistory();
        webView.loadUrl("about:blank");
        prefs.edit().remove(KEY_LAST_URL).remove(KEY_RECENT).apply();
        urlInput.setText("");
        setStatus(COLOR_IDLE);
        Toast.makeText(this, R.string.reset_done, Toast.LENGTH_SHORT).show();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }
}
