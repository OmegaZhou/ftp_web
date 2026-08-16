package com.ftpweb.client.config;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

/**
 * 账号凭据存储（机密）：EncryptedSharedPreferences + MasterKey 加密。
 * 加密层初始化失败时降级为普通 SharedPreferences，但 encrypted=false：
 * 密码只在 remember && encrypted 时才落盘，否则一律 remove，禁止明文写密码。
 * 单例，必须在 Application.onCreate 中先调用 init。
 */
public class AccountStore {
    private static final String PREFS_NAME = "account_secure";
    private static final String KEY_USERNAME = "username";
    private static final String KEY_PASSWORD = "password";
    private static final String KEY_REMEMBER = "remember";

    private static AccountStore instance;
    private final SharedPreferences prefs;
    private final boolean encrypted;

    private AccountStore(Context context) {
        SharedPreferences sp = null;
        boolean enc = false;
        try {
            MasterKey masterKey = new MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            sp = EncryptedSharedPreferences.create(
                    context,
                    PREFS_NAME,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
            enc = true;
        } catch (Exception e) {
            // 加密层初始化失败时降级为普通 SharedPreferences，保证应用可用；
            // encrypted=false 确保 save() 永不写明文密码。
            sp = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        }
        this.prefs = sp;
        this.encrypted = enc;
    }

    public static void init(Context context) {
        if (instance == null) {
            instance = new AccountStore(context.getApplicationContext());
        }
    }

    public static AccountStore getInstance() {
        return instance;
    }

    public String getUsername() {
        String u = prefs.getString(KEY_USERNAME, "");
        return u == null ? "" : u;
    }

    public String getPassword() {
        String p = prefs.getString(KEY_PASSWORD, "");
        return p == null ? "" : p;
    }

    public boolean isRemember() {
        return prefs.getBoolean(KEY_REMEMBER, false);
    }

    /**
     * remember=true 且加密层可用时才写密码；否则一律 remove 密码，避免明文落盘。
     * 账号与 remember 标志非机密，始终保存。
     */
    public void save(String username, String password, boolean remember) {
        SharedPreferences.Editor editor = prefs.edit();
        editor.putString(KEY_USERNAME, username == null ? "" : username);
        editor.putBoolean(KEY_REMEMBER, remember);
        if (remember && encrypted) {
            editor.putString(KEY_PASSWORD, password == null ? "" : password);
        } else {
            editor.remove(KEY_PASSWORD);
        }
        editor.apply();
    }

    public void clear() {
        prefs.edit()
                .remove(KEY_USERNAME)
                .remove(KEY_PASSWORD)
                .putBoolean(KEY_REMEMBER, false)
                .apply();
    }
}
