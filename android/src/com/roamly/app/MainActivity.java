package com.roamly.app;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Display;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import org.json.JSONObject;
import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoSessionSettings;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.WebExtension;
import org.mozilla.geckoview.WebRequestError;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {
    private static final int FILE_OPEN = 100, FILE_SAVE = 101, LOCATION_PERMISSION = 102;
    private static GeckoRuntime runtime;
    private GeckoView web;
    private GeckoSession session;
    private ProgressBar progress;
    private LinearLayout errorPanel;
    private boolean failed, canGoBack;
    private String saveId, saveText, locationId;
    private LocationManager locations;
    private GeckoSession.PromptDelegate.FilePrompt filePrompt;
    private GeckoResult<GeckoSession.PromptDelegate.PromptResponse> fileResult;
    private final Map<String, GeckoResult<Object>> pending = new HashMap<>();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable locationTimeout = () -> finishLocation(null, "定位超时，请检查系统定位服务后重试", 3);
    private final LocationListener locationListener = new LocationListener() {
        @Override public void onLocationChanged(Location value) { finishLocation(value, null, 0); }
        @Override public void onProviderEnabled(String provider) {}
        @Override public void onProviderDisabled(String provider) {}
        @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
    };
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().setNavigationBarColor(Color.WHITE);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        requestHighRefreshRate();
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(root);
        if (runtime == null) runtime = GeckoRuntime.create(getApplicationContext(), new GeckoRuntimeSettings.Builder()
            .remoteDebuggingEnabled(BuildConfig.DEBUG).consoleOutput(BuildConfig.DEBUG).build());
        web = new GeckoView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        root.addView(progress, new FrameLayout.LayoutParams(-1, (int)(3 * getResources().getDisplayMetrics().density)));
        errorPanel = new LinearLayout(this);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(android.view.Gravity.CENTER);
        errorPanel.setPadding(36, 36, 36, 36);
        errorPanel.setBackgroundColor(Color.WHITE);
        TextView message = new TextView(this);
        message.setText("暂时连接不上漫迹\n\n请确认手机已连接内网穿透网络，\n并且电脑上的漫迹服务正在运行。\n\n" + BuildConfig.SERVER_URL);
        message.setGravity(android.view.Gravity.CENTER); message.setTextSize(17);
        errorPanel.addView(message);
        Button retry = new Button(this); retry.setText("重新连接");
        retry.setOnClickListener(v -> { if (session == null || !session.isOpen()) createSession(); else session.loadUri(BuildConfig.SERVER_URL); });
        errorPanel.addView(retry); errorPanel.setVisibility(View.GONE);
        root.addView(errorPanel, new FrameLayout.LayoutParams(-1, -1));
        createSession();
    }
    private void requestHighRefreshRate() {
        Display display = getWindowManager().getDefaultDisplay();
        Display.Mode current = display.getMode(), selected = current;
        for (Display.Mode mode : display.getSupportedModes()) {
            if (mode.getPhysicalWidth() != current.getPhysicalWidth() || mode.getPhysicalHeight() != current.getPhysicalHeight()) continue;
            if (Math.abs(mode.getRefreshRate() - 120f) < .5f) { selected = mode; break; }
            if (mode.getRefreshRate() > selected.getRefreshRate()) selected = mode;
        }
        WindowManager.LayoutParams attributes = getWindow().getAttributes();
        attributes.preferredDisplayModeId = selected.getModeId();
        attributes.preferredRefreshRate = Math.max(120f, selected.getRefreshRate());
        getWindow().setAttributes(attributes);
        // Gecko follows display vsync; no fixed 60fps timer or compositor preference.
        if (BuildConfig.DEBUG) android.util.Log.i("RoamlyRefresh", "requested=120Hz selected=" + selected.getRefreshRate() + "Hz mode=" + selected.getModeId());
    }
    private void createSession() {
        if (session != null && session.isOpen()) session.close();
        session = new GeckoSession(new GeckoSessionSettings.Builder()
            .userAgentOverride(GeckoSession.getDefaultUserAgent() + " RoamlyAndroid/1.0 RoamlyGecko/157").build());
        session.setNavigationDelegate(new GeckoSession.NavigationDelegate() {
            @Override public void onCanGoBack(GeckoSession s, boolean value) { canGoBack = value; }
            @Override public GeckoResult<AllowOrDeny> onLoadRequest(GeckoSession s, LoadRequest request) {
                if (trusted(request.uri)) return GeckoResult.fromValue(AllowOrDeny.ALLOW);
                if (request.hasUserGesture) openExternal(Uri.parse(request.uri));
                return GeckoResult.fromValue(AllowOrDeny.DENY);
            }
            @Override public GeckoResult<GeckoSession> onNewSession(GeckoSession s, String uri) { openExternal(Uri.parse(uri)); return null; }
            @Override public GeckoResult<String> onLoadError(GeckoSession s, String uri, WebRequestError error) { showError(); return null; }
        });
        session.setProgressDelegate(new GeckoSession.ProgressDelegate() {
            @Override public void onPageStart(GeckoSession s, String url) { failed = false; errorPanel.setVisibility(View.GONE); progress.setVisibility(View.VISIBLE); }
            @Override public void onPageStop(GeckoSession s, boolean success) { progress.setVisibility(View.GONE); if (!success) showError(); else if (!failed) errorPanel.setVisibility(View.GONE); }
            @Override public void onProgressChange(GeckoSession s, int value) { progress.setProgress(value); }
        });
        session.setContentDelegate(new GeckoSession.ContentDelegate() { @Override public void onCrash(GeckoSession s) { showError(); } });
        session.setPromptDelegate(new GeckoSession.PromptDelegate() {
            @Override public GeckoResult<PromptResponse> onFilePrompt(GeckoSession s, FilePrompt prompt) {
                if (fileResult != null) fileResult.complete(filePrompt.dismiss());
                filePrompt = prompt; fileResult = new GeckoResult<>(); GeckoResult<PromptResponse> result = fileResult;
                try { startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), FILE_OPEN); }
                catch (Exception e) { fileResult.complete(prompt.dismiss()); filePrompt = null; fileResult = null; android.widget.Toast.makeText(MainActivity.this, "请安装或启用系统文件应用", 1).show(); }
                return result;
            }
        });
        session.open(runtime); web.setSession(session);
        final GeckoSession target = session;
        runtime.getWebExtensionController().ensureBuiltIn("resource://android/assets/messaging/", "roamly-native@roamly.local").accept(extension -> {
            if (target != session || isFinishing()) return;
            target.getWebExtensionController().setMessageDelegate(extension, new WebExtension.MessageDelegate() {
                @Override public GeckoResult<Object> onMessage(String app, Object message, WebExtension.MessageSender sender) {
                    if (sender.session != target || !sender.isTopLevel() || !trusted(sender.url) || !(message instanceof JSONObject)) return GeckoResult.fromValue(errorResult("手机功能不可用", 0).toString());
                    JSONObject call = (JSONObject)message;
                    String id = call.optString("id"), method = call.optString("method");
                    if (id.isEmpty() || id.length() > 100 || pending.size() >= 128 || pending.containsKey(id)) return GeckoResult.fromValue(errorResult("请求无效", 0).toString());
                    GeckoResult<Object> result = new GeckoResult<>(); pending.put(id, result);
                    JSONObject args = call.optJSONObject("args"); dispatch(id, method, args == null ? new JSONObject() : args);
                    return result;
                }
            }, "roamly");
            target.loadUri(BuildConfig.SERVER_URL + (BuildConfig.DEBUG && getIntent().getBooleanExtra("qa", false) ? "/?roamlyQa=1" : ""));
        }, error -> { android.util.Log.e("Roamly", "Native bridge initialization failed", error); showError(); });
    }
    private boolean trusted(String url) {
        if (url == null) return false;
        Uri actual = Uri.parse(url), base = Uri.parse(BuildConfig.SERVER_URL);
        return base.getScheme().equals(actual.getScheme()) && base.getHost().equals(actual.getHost()) && base.getPort() == actual.getPort();
    }
    private void showError() { failed = true; progress.setVisibility(View.GONE); errorPanel.setVisibility(View.VISIBLE); }
    private void openExternal(Uri uri) {
        if (!"http".equals(uri.getScheme()) && !"https".equals(uri.getScheme()) && !"tel".equals(uri.getScheme()) && !"mailto".equals(uri.getScheme())) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception e) { android.widget.Toast.makeText(this, "手机上没有可打开此链接的应用", 0).show(); }
    }
    private JSONObject errorResult(String message, int code) {
        JSONObject result = new JSONObject(); try { result.put("error", message); result.put("code", code); } catch (Exception ignored) {} return result;
    }
    private void reply(String id, Object value, String error, int code) {
        GeckoResult<Object> result = pending.remove(id); if (result == null) return;
        try { result.complete((error == null ? new JSONObject().put("value", value) : errorResult(error, code)).toString()); }
        catch (Exception e) { result.complete(errorResult("手机操作失败，请重试", 0).toString()); }
    }
    private void dispatch(String id, String method, JSONObject args) {
        try {
            switch (method) {
                case "qaReport":
                    if (!BuildConfig.DEBUG) { reply(id, null, "不支持的手机操作", 0); break; }
                    try (OutputStream output = openFileOutput("motion-qa.json", MODE_PRIVATE)) { output.write(args.toString(2).getBytes(StandardCharsets.UTF_8)); }
                    android.util.Log.i("RoamlyQA", "Animation verification report saved"); reply(id, true, null, 0); break;
                case "copy":
                    ((ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("漫迹", args.getString("text")));
                    reply(id, true, null, 0); break;
                case "saveFile":
                    if (saveId != null) { reply(id, null, "请先完成当前文件保存", 0); break; }
                    String text = args.getString("text");
                    if (text.getBytes(StandardCharsets.UTF_8).length > 2 * 1024 * 1024) throw new IllegalArgumentException("行程文件不能超过 2 MB");
                    saveId = id; saveText = text;
                    startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream")
                        .putExtra(Intent.EXTRA_TITLE, args.getString("name").replaceAll("[\\\\/:*?\"<>|]", "-")), FILE_SAVE); break;
                case "location":
                    if (locationId != null) { reply(id, null, "正在定位，请稍候", 0); break; }
                    locationId = id;
                    if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_PERMISSION);
                    else startLocation(); break;
                default: reply(id, null, "不支持的手机操作", 0);
            }
        } catch (android.content.ActivityNotFoundException e) {
            if (id.equals(saveId)) { saveId = null; saveText = null; }
            reply(id, null, "手机未提供文件保存器，请安装或启用系统文件应用后重试", 0);
        } catch (Exception e) { reply(id, null, e.getMessage() == null ? "手机操作失败，请重试" : e.getMessage(), 0); }
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(request, permissions, grants);
        if (request == LOCATION_PERMISSION && locationId != null) {
            if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) startLocation();
            else finishLocation(null, "定位权限被拒绝，请在系统设置中允许漫迹访问位置", 1);
        }
    }
    private void startLocation() {
        locations = (LocationManager)getSystemService(LOCATION_SERVICE);
        if (!locations.isLocationEnabled()) { finishLocation(null, "系统定位服务未开启，请开启后重试", 1); return; }
        boolean started = false;
        for (String provider : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
            try {
                if (!locations.isProviderEnabled(provider)) continue;
                Location recent = locations.getLastKnownLocation(provider);
                if (recent != null && android.os.SystemClock.elapsedRealtimeNanos() - recent.getElapsedRealtimeNanos() < 60000000000L) { finishLocation(recent, null, 0); return; }
                locations.requestLocationUpdates(provider, 0, 0, locationListener, Looper.getMainLooper()); started = true;
            } catch (SecurityException | IllegalArgumentException ignored) {}
        }
        if (started) handler.postDelayed(locationTimeout, 15000); else finishLocation(null, "手机暂时无法获取位置，请检查定位权限和系统定位服务", 2);
    }
    private void finishLocation(Location location, String error, int code) {
        handler.removeCallbacks(locationTimeout); if (locations != null) locations.removeUpdates(locationListener);
        String id = locationId; locationId = null; if (id == null) return;
        try {
            JSONObject position = new JSONObject();
            if (location != null) position.put("coords", new JSONObject().put("longitude", location.getLongitude()).put("latitude", location.getLatitude()).put("accuracy", location.getAccuracy()));
            reply(id, position, error, code);
        } catch (Exception e) { reply(id, null, "定位结果无效，请重试", 2); }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == FILE_OPEN && fileResult != null) {
            fileResult.complete(result == RESULT_OK && data != null && data.getData() != null ? filePrompt.confirm(this, data.getData()) : filePrompt.dismiss()); fileResult = null; filePrompt = null;
        }
        if (request == FILE_SAVE && saveId != null) {
            String id = saveId, text = saveText; saveId = null; saveText = null;
            if (result != RESULT_OK || data == null || data.getData() == null) { reply(id, false, null, 0); return; }
            try (OutputStream stream = getContentResolver().openOutputStream(data.getData(), "wt")) {
                if (stream == null) throw new IllegalStateException(); stream.write(text.getBytes(StandardCharsets.UTF_8)); reply(id, true, null, 0);
            } catch (Exception e) { reply(id, null, "文件保存失败，请换一个保存位置", 0); }
        }
    }
    @Override public void onBackPressed() { if (canGoBack) session.goBack(); else super.onBackPressed(); }
    @Override protected void onResume() { super.onResume(); requestHighRefreshRate(); }
    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null); if (locations != null) locations.removeUpdates(locationListener);
        if (fileResult != null) fileResult.complete(filePrompt.dismiss());
        for (GeckoResult<Object> result : pending.values()) result.complete(errorResult("应用已关闭", 0).toString()); pending.clear();
        web.releaseSession(); if (session != null && session.isOpen()) session.close(); super.onDestroy();
    }
}
