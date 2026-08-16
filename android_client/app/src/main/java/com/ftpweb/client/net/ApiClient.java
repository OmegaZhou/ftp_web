package com.ftpweb.client.net;

import android.os.Handler;
import android.os.Looper;

import com.ftpweb.client.config.ServerConfig;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.FormBody;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 统一网络层（OkHttp 单例）：
 * - 管理 baseUrl 与 connect.sid 会话 cookie；
 * - 所有回调切到主线程分发，UI 可直接操作控件；
 * - 统一响应解析：message == "success" → onSuccess(result)，否则 → onFailure(message)。
 */
public class ApiClient {
    public static final String MSG_SUCCESS = "success";
    public static final String MSG_NEED_LOGIN = "Need login";

    private static final String API_BASE = "/ftp/api/";
    private static final int CONNECT_TIMEOUT = 15;
    private static final int READ_TIMEOUT = 60;

    private static ApiClient instance;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final OkHttpClient httpClient;
    private String baseUrl;

    private ApiClient() {
        ServerConfig config = ServerConfig.getInstance();
        if (config != null) {
            String saved = config.getBaseUrl();
            if (saved != null && !saved.isEmpty()) {
                baseUrl = saved;
            }
        }
        httpClient = new OkHttpClient.Builder()
                .connectTimeout(CONNECT_TIMEOUT, TimeUnit.SECONDS)
                .readTimeout(READ_TIMEOUT, TimeUnit.SECONDS)
                .cookieJar(new PersistentCookieJar())
                .build();
    }

    public static synchronized ApiClient getInstance() {
        if (instance == null) {
            instance = new ApiClient();
        }
        return instance;
    }

    public void setBaseUrl(String url) {
        if (url == null) {
            return;
        }
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        this.baseUrl = url;
    }

    public String getBaseUrl() {
        return baseUrl == null ? "" : baseUrl;
    }

    /** 是否已登录（是否存有 connect.sid） */
    public boolean hasSession() {
        return PersistentCookieJar.hasSession();
    }

    public void clearSession() {
        PersistentCookieJar.clearSession();
    }

    // ------------------------------------------------------------------
    // 登录
    // ------------------------------------------------------------------

    /**
     * 登录流程：后台线程拉取 RSA 公钥并加密 → POST /ftp/api/login。
     * 成功时 onSuccess(result)（result 可能为 null）；失败时 onFailure(message)。
     */
    public void login(final String username, final String password, final ApiCallback cb) {
        if (baseUrl == null || baseUrl.isEmpty()) {
            dispatchFailure(cb, "服务器地址未配置");
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    String encUser = RsaHelper.encrypt(username);
                    String encPass = RsaHelper.encrypt(password);
                    FormBody form = new FormBody.Builder()
                            .add("user", encUser)
                            .add("password", encPass)
                            .build();
                    Request req = new Request.Builder()
                            .url(baseUrl + API_BASE + "login")
                            .post(form)
                            .build();
                    Response resp = httpClient.newCall(req).execute();
                    try {
                        String body = resp.body() == null ? null : resp.body().string();
                        handleJsonResponse(body, cb);
                    } finally {
                        resp.close();
                    }
                } catch (Exception e) {
                    dispatchFailure(cb, e.getMessage() == null ? "登录失败" : e.getMessage());
                }
            }
        }).start();
    }

    // ------------------------------------------------------------------
    // 目录 / 文件操作
    // ------------------------------------------------------------------

    /** 成功时 result = JSONArray 字符串（元素含 name/type/size/date） */
    public void getDir(ApiCallback cb) {
        enqueue(new Request.Builder().url(baseUrl + API_BASE + "get_dir").get().build(), cb);
    }

    /** 成功时 result = 当前目录字符串，如 "/a/b/" */
    public void pwd(ApiCallback cb) {
        enqueue(new Request.Builder().url(baseUrl + API_BASE + "pwd").get().build(), cb);
    }

    public void changeDir(String path, ApiCallback cb) {
        enqueue(postForm("change_dir", new String[][]{{"path", path}}), cb);
    }

    public void mkdir(String path, ApiCallback cb) {
        enqueue(postForm("mkdir", new String[][]{{"path", path}}), cb);
    }

    public void rename(String oldPath, String newPath, ApiCallback cb) {
        enqueue(postForm("rename", new String[][]{{"old_path", oldPath}, {"new_path", newPath}}), cb);
    }

    public void rmdir(String path, ApiCallback cb) {
        enqueue(postForm("rmdir", new String[][]{{"path", path}}), cb);
    }

    public void deleteFile(String path, ApiCallback cb) {
        enqueue(postForm("delete_file", new String[][]{{"path", path}}), cb);
    }

    public void logout(ApiCallback cb) {
        enqueue(new Request.Builder().url(baseUrl + API_BASE + "logout").get().build(), cb);
    }

    // ------------------------------------------------------------------
    // 上传 / 下载
    // ------------------------------------------------------------------

    /**
     * multipart 上传，字段 file/name/path。
     * 注意：服务端按 path+name 拼接，remotePath 应传目录路径（含尾部斜杠，如 "/a/b/"）。
     */
    public void upload(final String remotePath, final String fileName, final File localFile, final ApiCallback cb) {
        if (localFile == null || !localFile.exists()) {
            dispatchFailure(cb, "本地文件不存在: " + (localFile == null ? "" : localFile.getAbsolutePath()));
            return;
        }
        if (fileName == null || fileName.isEmpty()) {
            dispatchFailure(cb, "文件名不能为空");
            return;
        }
        MediaType octet = MediaType.parse("application/octet-stream");
        RequestBody fileBody = RequestBody.create(localFile, octet);
        MultipartBody body = new MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", fileName, fileBody)
                .addFormDataPart("name", fileName)
                .addFormDataPart("path", remotePath == null ? "" : remotePath)
                .build();
        Request req = new Request.Builder()
                .url(baseUrl + API_BASE + "upload")
                .post(body)
                .build();
        enqueue(req, cb);
    }

    /**
     * 流式下载写盘，成功时 result = null。
     * 路径用 URLEncoder.encode + replace("+","%20") 对齐服务端 decodeURIComponent 语义。
     */
    public void download(final String remotePath, final File outFile, final ApiCallback cb) {
        if (outFile == null) {
            dispatchFailure(cb, "下载目标文件未指定");
            return;
        }
        if (remotePath == null || remotePath.isEmpty()) {
            dispatchFailure(cb, "下载路径不能为空");
            return;
        }
        String encPath;
        try {
            // Android 无 encode(String, Charset)，用 "UTF-8" 重载；
            // replace("+","%20") 对齐服务端 decodeURIComponent 语义。
            encPath = URLEncoder.encode(remotePath, "UTF-8").replace("+", "%20");
        } catch (UnsupportedEncodingException e) {
            dispatchFailure(cb, "路径编码失败");
            return;
        }
        Request req = new Request.Builder()
                .url(baseUrl + API_BASE + "download/" + encPath)
                .get()
                .build();
        httpClient.newCall(req).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                dispatchFailure(cb, e.getMessage() == null ? "下载失败" : e.getMessage());
            }

            @Override
            public void onResponse(Call call, Response resp) throws IOException {
                try {
                    if (!resp.isSuccessful()) {
                        dispatchFailure(cb, "下载失败, HTTP " + resp.code());
                        return;
                    }
                    ResponseBody body = resp.body();
                    if (body == null) {
                        dispatchFailure(cb, "下载失败: 响应无内容");
                        return;
                    }
                    // try-with-resources 保证 InputStream / FileOutputStream 双关：
                    // 任一写盘抛异常也不会跳过另一个的关闭；resp 仍在外层 finally 关闭。
                    try (InputStream in = body.byteStream();
                         FileOutputStream out = new FileOutputStream(outFile)) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = in.read(buf)) != -1) {
                            out.write(buf, 0, n);
                        }
                        out.flush();
                    }
                    dispatchSuccess(cb, null);
                } catch (Exception e) {
                    dispatchFailure(cb, e.getMessage() == null ? "下载失败" : e.getMessage());
                } finally {
                    resp.close();
                }
            }
        });
    }

    // ------------------------------------------------------------------
    // 内部工具
    // ------------------------------------------------------------------

    private Request postForm(String api, String[][] fields) {
        FormBody.Builder fb = new FormBody.Builder();
        for (String[] f : fields) {
            fb.add(f[0], f[1] == null ? "" : f[1]);
        }
        return new Request.Builder()
                .url(baseUrl + API_BASE + api)
                .post(fb.build())
                .build();
    }

    private void enqueue(Request req, final ApiCallback cb) {
        httpClient.newCall(req).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                dispatchFailure(cb, e.getMessage() == null ? "网络错误" : e.getMessage());
            }

            @Override
            public void onResponse(Call call, Response resp) throws IOException {
                try {
                    String body = resp.body() == null ? null : resp.body().string();
                    handleJsonResponse(body, cb);
                } catch (Exception e) {
                    dispatchFailure(cb, e.getMessage() == null ? "响应解析失败" : e.getMessage());
                } finally {
                    resp.close();
                }
            }
        });
    }

    /**
     * 统一响应解析：message == "success" → onSuccess(result)；否则 → onFailure(message)。
     * result 可能是 JSONArray/JSONObject/纯字符串/null，用 org.json 提取其原始文本，
     * 避免 Gson 将 String 字段映射到数组/对象时报错。
     */
    private void handleJsonResponse(String body, ApiCallback cb) {
        if (body == null || body.isEmpty()) {
            dispatchFailure(cb, "服务端无响应");
            return;
        }
        String message;
        String result;
        try {
            JSONObject obj = new JSONObject(body);
            message = obj.optString("message");
            if (obj.has("result") && !obj.isNull("result")) {
                result = obj.get("result").toString();
            } else {
                result = null;
            }
        } catch (Exception e) {
            dispatchFailure(cb, "响应解析失败");
            return;
        }
        if (message == null || message.isEmpty()) {
            dispatchFailure(cb, "响应格式异常");
            return;
        }
        if (MSG_SUCCESS.equals(message)) {
            dispatchSuccess(cb, result);
        } else {
            dispatchFailure(cb, message);
        }
    }

    private void dispatchSuccess(final ApiCallback cb, final String result) {
        if (cb == null) {
            return;
        }
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                cb.onSuccess(result);
            }
        });
    }

    private void dispatchFailure(final ApiCallback cb, final String message) {
        if (cb == null) {
            return;
        }
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                cb.onFailure(message);
            }
        });
    }

    /**
     * 会话回调契约：result 为响应 result 的字符串（JSONArray/路径/null），
     * message 为服务端 message（如 "Need login"）或网络异常描述。
     */
    public interface ApiCallback {
        void onSuccess(String result);

        void onFailure(String message);
    }

    /**
     * 持久化 connect.sid 会话 cookie 的 CookieJar。
     */
    static class PersistentCookieJar implements CookieJar {
        private static final String SID_NAME = "connect.sid";
        private static volatile String sidValue;
        private static final List<Cookie> EMPTY = Collections.emptyList();

        static boolean hasSession() {
            return sidValue != null;
        }

        static void clearSession() {
            sidValue = null;
        }

        @Override
        public void saveFromResponse(HttpUrl url, List<Cookie> cookies) {
            for (Cookie c : cookies) {
                if (SID_NAME.equals(c.name())) {
                    if (c.expiresAt() < System.currentTimeMillis()) {
                        sidValue = null;
                    } else {
                        sidValue = c.value();
                    }
                }
            }
        }

        @Override
        public List<Cookie> loadForRequest(HttpUrl url) {
            if (sidValue == null) {
                return EMPTY;
            }
            try {
                Cookie cookie = new Cookie.Builder()
                        .name(SID_NAME)
                        .value(sidValue)
                        .hostOnlyDomain(url.host())   // hostOnlyDomain 而非 domain，IP 域名语义更正确
                        .path("/")
                        .build();
                return Collections.singletonList(cookie);
            } catch (Exception e) {
                // 域名非法时降级为不带 cookie，避免崩溃
                return EMPTY;
            }
        }
    }
}
