package com.ftpweb.client;

import android.app.Application;
import android.util.Log;

import com.ftpweb.client.config.AccountStore;
import com.ftpweb.client.config.ServerConfig;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.Date;

/**
 * 应用入口：
 * 1) 初始化 ServerConfig（域名/协议）与 AccountStore（加密凭据）；
 * 2) 全局崩溃捕获：把未捕获异常完整堆栈追加写入 crash_log.txt，供「登录后闪退」取证。
 */
public class App extends Application {
    private static final String TAG = "FtpWebClient";
    private static final String CRASH_LOG_NAME = "crash_log.txt";

    @Override
    public void onCreate() {
        super.onCreate();
        ServerConfig.init(this);
        AccountStore.init(this);
        installCrashHandler();
    }

    private void installCrashHandler() {
        final Thread.UncaughtExceptionHandler original =
                Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread thread, Throwable throwable) {
                writeCrashLog(thread, throwable);
                // 委托给原 handler，保持系统默认崩溃行为（进程仍会终止）
                if (original != null) {
                    original.uncaughtException(thread, throwable);
                }
            }
        });
    }

    /**
     * 把崩溃堆栈（含线程名、时间戳）追加写入 app 外部私有目录的 crash_log.txt。
     * 写日志自身的任何异常必须吞掉，防止二次崩溃。
     * 取证：文件路径为 getExternalFilesDir(null)/crash_log.txt，
     * 即 Android/data/com.ftpweb.client/files/crash_log.txt，供「登录后闪退」
     * 用 adb pull 或文件管理器取用。
     */
    private void writeCrashLog(Thread thread, Throwable throwable) {
        try {
            File dir = getExternalFilesDir(null);
            if (dir == null) {
                return;
            }
            StringWriter sw = new StringWriter();
            PrintWriter pw = new PrintWriter(sw);
            pw.println("=== " + new Date().toString() + " ===");
            pw.println("Thread: " + (thread == null ? "unknown" : thread.getName()));
            throwable.printStackTrace(pw);
            pw.flush();

            File file = new File(dir, CRASH_LOG_NAME);
            FileOutputStream fos = new FileOutputStream(file, true);
            try {
                fos.write(sw.toString().getBytes(StandardCharsets.UTF_8));
                fos.write("\n\n".getBytes(StandardCharsets.UTF_8));
                fos.flush();
            } finally {
                fos.close();
            }
            Log.e(TAG, "Crash captured", throwable);
        } catch (Throwable ignored) {
            // 吞掉日志写入异常，不能因此二次崩溃
            Log.e(TAG, "Failed to write crash log", ignored);
        }
    }
}
