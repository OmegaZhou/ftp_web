package com.ftpweb.client.config;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Locale;

/**
 * 服务器配置（域名/协议）：普通 SharedPreferences 存储，非机密。
 * 域名属于配置而非凭据，故不做加密；账号密码见 AccountStore（加密）。
 * 单例，必须在 Application.onCreate 中先调用 init。
 */
public class ServerConfig {
    private static final String PREFS_NAME = "server_config";
    private static final String KEY_PROTOCOL = "protocol";
    private static final String KEY_HOST = "host";

    private static ServerConfig instance;
    private final SharedPreferences prefs;

    private ServerConfig(Context context) {
        prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static void init(Context context) {
        if (instance == null) {
            instance = new ServerConfig(context.getApplicationContext());
        }
    }

    public static ServerConfig getInstance() {
        return instance;
    }

    /** "http" 或 "https"，默认 "http" */
    public String getProtocol() {
        String p = prefs.getString(KEY_PROTOCOL, "http");
        return p == null ? "http" : p;
    }

    /** 只接受 "http"/"https"，非法忽略 */
    public void setProtocol(String protocol) {
        if (protocol == null) {
            return;
        }
        if ("http".equals(protocol) || "https".equals(protocol)) {
            prefs.edit().putString(KEY_PROTOCOL, protocol).apply();
        }
    }

    /** 形如 "192.168.1.10:9090"，永不含 "://"；未配置返回 "" */
    public String getHost() {
        String h = prefs.getString(KEY_HOST, "");
        if (h == null) {
            return "";
        }
        h = h.trim();
        // 防御：历史值若混入过完整 URL，读取时剔除协议前缀，保证 getHost() 永不含 "://"
        int idx = h.indexOf("://");
        if (idx >= 0) {
            h = h.substring(idx + 3);
        }
        return h;
    }

    /** 去空白、去首尾斜杠；若误传入完整 URL 也会剥离协议前缀 */
    public void setHost(String host) {
        if (host == null) {
            host = "";
        }
        host = host.trim();
        // 防御：剥离误传入的协议前缀
        int idx = host.indexOf("://");
        if (idx >= 0) {
            host = host.substring(idx + 3);
        }
        while (host.startsWith("/")) {
            host = host.substring(1);
        }
        while (host.endsWith("/")) {
            host = host.substring(0, host.length() - 1);
        }
        prefs.edit().putString(KEY_HOST, host).apply();
    }

    /** protocol + "://" + host；因 getHost() 永不含 "://"，此处不会出现 "http://http://..." */
    public String getBaseUrl() {
        return getProtocol() + "://" + getHost();
    }

    /**
     * 兼容解析：若含 "://" 则拆出 protocol 与 host（protocol 非 http/https 时忽略，
     * 仅 host 生效）；否则整个 url 作为 host 存储；统一去尾部斜杠。
     */
    public void setBaseUrl(String url) {
        if (url == null) {
            url = "";
        }
        url = url.trim();
        int idx = url.indexOf("://");
        if (idx > 0) {
            String protocol = url.substring(0, idx).toLowerCase(Locale.ROOT);
            if ("http".equals(protocol) || "https".equals(protocol)) {
                setProtocol(protocol);
            }
            setHost(url.substring(idx + 3));
        } else {
            setHost(url);
        }
    }

    public void clear() {
        prefs.edit()
                .remove(KEY_PROTOCOL)
                .remove(KEY_HOST)
                .apply();
    }
}
