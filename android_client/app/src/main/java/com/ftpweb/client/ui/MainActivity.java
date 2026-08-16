package com.ftpweb.client.ui;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.text.TextUtils;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.ftpweb.client.R;
import com.ftpweb.client.config.AccountStore;
import com.ftpweb.client.model.FtpItem;
import com.ftpweb.client.net.ApiClient;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Collections;
import java.util.List;

/**
 * 主界面：面包屑导航 + 目录/文件列表 + 新建文件夹/上传/登出。
 */
public class MainActivity extends AppCompatActivity implements FileAdapter.FileActionListener {

    private static final int REQ_PICK_FILE = 1001;

    /** 当前目录，始终带尾部斜杠，如 "/a/b/" */
    private String nowDir = "/";

    private final ApiClient api = ApiClient.getInstance();

    private LinearLayout llBreadcrumb;
    private RecyclerView rvFiles;
    private ProgressBar pbLoading;
    private TextView tvEmpty;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        llBreadcrumb = findViewById(R.id.ll_breadcrumb);
        rvFiles = findViewById(R.id.rv_files);
        pbLoading = findViewById(R.id.pb_loading);
        tvEmpty = findViewById(R.id.tv_empty);

        rvFiles.setLayoutManager(new LinearLayoutManager(this));
        rvFiles.setAdapter(new FileAdapter(this));

        TextView tvBackRoot = findViewById(R.id.tv_back_root);
        tvBackRoot.setOnClickListener(v -> changeDir("/"));

        Button btnMkdir = findViewById(R.id.btn_mkdir);
        btnMkdir.setOnClickListener(v -> showMkdirDialog());

        Button btnUpload = findViewById(R.id.btn_upload);
        btnUpload.setOnClickListener(v -> pickFile());

        Button btnLogout = findViewById(R.id.btn_logout);
        btnLogout.setOnClickListener(v -> doLogout());

        refresh();
    }

    // ------------------------------------------------------------------
    // 数据加载
    // ------------------------------------------------------------------

    private void refresh() {
        showLoading(true);
        api.pwd(new ApiClient.ApiCallback() {
            @Override
            public void onSuccess(String result) {
                buildBreadcrumb(result);
                loadDir();
            }

            @Override
            public void onFailure(String message) {
                showLoading(false);
                if (handleSessionError(message)) {
                    return;
                }
                toast(message == null ? getString(R.string.operation_failed) : message);
            }
        });
    }

    private void loadDir() {
        api.getDir(new ApiClient.ApiCallback() {
            @Override
            public void onSuccess(String result) {
                showLoading(false);
                List<FtpItem> list = parseItems(result);
                ((FileAdapter) rvFiles.getAdapter()).setItems(list);
                tvEmpty.setVisibility(list.isEmpty() ? View.VISIBLE : View.GONE);
            }

            @Override
            public void onFailure(String message) {
                showLoading(false);
                if (handleSessionError(message)) {
                    return;
                }
                toast(message == null ? getString(R.string.operation_failed) : message);
            }
        });
    }

    private List<FtpItem> parseItems(String jsonArrayStr) {
        if (TextUtils.isEmpty(jsonArrayStr)) {
            return Collections.emptyList();
        }
        try {
            List<FtpItem> list = new Gson().fromJson(
                    jsonArrayStr, new TypeToken<List<FtpItem>>() {}.getType());
            return list == null ? Collections.emptyList() : list;
        } catch (Exception e) {
            return Collections.emptyList();
        }
    }

    private void showLoading(boolean show) {
        pbLoading.setVisibility(show ? View.VISIBLE : View.GONE);
        rvFiles.setVisibility(show ? View.GONE : View.VISIBLE);
    }

    // ------------------------------------------------------------------
    // 面包屑
    // ------------------------------------------------------------------

    private void buildBreadcrumb(String path) {
        String p = path == null ? "/" : path;
        if (!p.startsWith("/")) {
            p = "/" + p;
        }
        if (!p.endsWith("/")) {
            p += "/";
        }
        nowDir = p;

        llBreadcrumb.removeAllViews();
        addSegment("/", "/");
        String[] parts = p.split("/");
        StringBuilder cur = new StringBuilder();
        for (String seg : parts) {
            if (seg.isEmpty()) {
                continue;
            }
            cur.append(seg).append('/');
            addSegment(seg + "/", cur.toString());
        }
    }

    private void addSegment(String text, final String path) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(15f);
        tv.setPadding(dp(2), 0, dp(2), 0);
        tv.setTextColor(ContextCompat.getColor(this, R.color.purple_500));
        tv.setOnClickListener(v -> changeDir(path));
        llBreadcrumb.addView(tv);
    }

    private void changeDir(String path) {
        if (TextUtils.isEmpty(path)) {
            return;
        }
        api.changeDir(path, new ApiClient.ApiCallback() {
            @Override
            public void onSuccess(String result) {
                refresh();
            }

            @Override
            public void onFailure(String message) {
                if (handleSessionError(message)) {
                    return;
                }
                toast(message == null ? getString(R.string.operation_failed) : message);
            }
        });
    }

    // ------------------------------------------------------------------
    // 顶部按钮：新建文件夹 / 上传 / 登出
    // ------------------------------------------------------------------

    private void showMkdirDialog() {
        showInputDialog(R.string.mkdir_title, R.string.mkdir_hint, null, new InputCallback() {
            @Override
            public void onInput(String name) {
                api.mkdir(nowDir + name, new ApiClient.ApiCallback() {
                    @Override
                    public void onSuccess(String result) {
                        toast(getString(R.string.mkdir_success));
                        refresh();
                    }

                    @Override
                    public void onFailure(String message) {
                        if (handleSessionError(message)) {
                            return;
                        }
                        toast(message == null ? getString(R.string.operation_failed) : message);
                    }
                });
            }
        });
    }

    private void pickFile() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("*/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(Intent.createChooser(intent, getString(R.string.upload_title)),
                REQ_PICK_FILE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK_FILE) {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) {
                toast(getString(R.string.pick_file_cancelled));
                return;
            }
            handlePickedUri(data.getData());
        }
    }

    private void handlePickedUri(Uri uri) {
        String displayName = queryDisplayName(uri);
        if (TextUtils.isEmpty(displayName)) {
            displayName = "upload_" + System.currentTimeMillis();
        }

        final File localFile;
        try {
            localFile = copyToCache(uri, displayName);
        } catch (Exception e) {
            toast(getString(R.string.pick_file_failed));
            return;
        }

        showInputDialog(R.string.upload_title, R.string.upload_hint, displayName, new InputCallback() {
            @Override
            public void onInput(String fileName) {
                if (TextUtils.isEmpty(fileName)) {
                    toast(getString(R.string.input_cannot_empty));
                    return;
                }
                toast(getString(R.string.uploading));
                api.upload(nowDir, fileName, localFile, new ApiClient.ApiCallback() {
                    @Override
                    public void onSuccess(String result) {
                        toast(getString(R.string.upload_success));
                        refresh();
                    }

                    @Override
                    public void onFailure(String message) {
                        if (handleSessionError(message)) {
                            return;
                        }
                        toast(message == null ? getString(R.string.upload_fail) : message);
                    }
                });
            }
        });
    }

    private void doLogout() {
        api.logout(new ApiClient.ApiCallback() {
            @Override
            public void onSuccess(String result) {
                goToLogin();
            }

            @Override
            public void onFailure(String message) {
                // 服务端登出异常也回到登录页，本地会话一并清除
                goToLogin();
            }
        });
    }

    // ------------------------------------------------------------------
    // 列表操作：进入 / 下载 / 删除 / 重命名
    // ------------------------------------------------------------------

    @Override
    public void onEnterDir(FtpItem item) {
        changeDir(nowDir + item.getName());
    }

    @Override
    public void onDownload(FtpItem item) {
        File downloadDir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (downloadDir == null) {
            toast(getString(R.string.download_fail));
            return;
        }
        final File outFile = new File(downloadDir, item.getName());
        toast(getString(R.string.downloading));
        api.download(nowDir + item.getName(), outFile, new ApiClient.ApiCallback() {
            @Override
            public void onSuccess(String result) {
                toast(getString(R.string.download_success, outFile.getAbsolutePath()));
            }

            @Override
            public void onFailure(String message) {
                if (handleSessionError(message)) {
                    return;
                }
                toast(message == null ? getString(R.string.download_fail) : message);
            }
        });
    }

    @Override
    public void onDelete(final FtpItem item) {
        new AlertDialog.Builder(this)
                .setTitle(R.string.delete_title)
                .setMessage(getString(R.string.delete_message, item.getName()))
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.confirm, (d, w) -> {
                    String path = nowDir + item.getName();
                    ApiClient.ApiCallback cb = new ApiClient.ApiCallback() {
                        @Override
                        public void onSuccess(String result) {
                            toast(getString(R.string.delete_success));
                            refresh();
                        }

                        @Override
                        public void onFailure(String message) {
                            if (handleSessionError(message)) {
                                return;
                            }
                            toast(message == null ? getString(R.string.operation_failed) : message);
                        }
                    };
                    if (item.isDirectory()) {
                        api.rmdir(path, cb);
                    } else {
                        api.deleteFile(path, cb);
                    }
                })
                .show();
    }

    @Override
    public void onRename(final FtpItem item) {
        showInputDialog(R.string.rename_title, R.string.rename_hint, item.getName(), new InputCallback() {
            @Override
            public void onInput(String newName) {
                if (TextUtils.isEmpty(newName)) {
                    toast(getString(R.string.input_cannot_empty));
                    return;
                }
                api.rename(nowDir + item.getName(), nowDir + newName, new ApiClient.ApiCallback() {
                    @Override
                    public void onSuccess(String result) {
                        toast(getString(R.string.rename_success));
                        refresh();
                    }

                    @Override
                    public void onFailure(String message) {
                        if (handleSessionError(message)) {
                            return;
                        }
                        toast(message == null ? getString(R.string.operation_failed) : message);
                    }
                });
            }
        });
    }

    // ------------------------------------------------------------------
    // 通用输入对话框（新建/上传/重命名共用）
    // ------------------------------------------------------------------

    private interface InputCallback {
        void onInput(String text);
    }

    private void showInputDialog(int titleRes, int hintRes, String prefill, final InputCallback callback) {
        View view = getLayoutInflater().inflate(R.layout.dialog_common, null);
        final EditText etInput = view.findViewById(R.id.et_input);
        etInput.setHint(hintRes);
        if (!TextUtils.isEmpty(prefill)) {
            etInput.setText(prefill);
            etInput.setSelection(prefill.length());
        }

        final AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(titleRes)
                .setView(view)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.confirm, null)
                .create();

        // 覆盖确认按钮：输入为空时 Toast 提示并保持对话框打开
        dialog.setOnShowListener(d -> {
            Button confirmBtn = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            confirmBtn.setOnClickListener(v -> {
                String text = etInput.getText().toString().trim();
                if (TextUtils.isEmpty(text)) {
                    toast(getString(R.string.input_cannot_empty));
                    return;
                }
                dialog.dismiss();
                callback.onInput(text);
            });
        });

        dialog.show();
    }

    // ------------------------------------------------------------------
    // 会话失效处理
    // ------------------------------------------------------------------

    private boolean handleSessionError(String message) {
        if (message != null && message.equals(ApiClient.MSG_NEED_LOGIN)) {
            AccountStore.getInstance().clear();
            api.clearSession();
            toast(getString(R.string.session_expired));
            goToLogin();
            return true;
        }
        return false;
    }

    private void goToLogin() {
        api.clearSession();
        Intent intent = new Intent(this, LoginActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(intent);
        finish();
    }

    // ------------------------------------------------------------------
    // 工具方法
    // ------------------------------------------------------------------

    @Nullable
    private String queryDisplayName(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(uri, null, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    return cursor.getString(idx);
                }
            }
        } catch (Exception e) {
            // 忽略查询异常，返回 null 交由调用方兜底
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return null;
    }

    private File copyToCache(Uri uri, String name) throws IOException {
        File dir = new File(getCacheDir(), "uploads");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("cannot create cache dir");
        }
        File outFile = new File(dir, name);
        InputStream in = null;
        OutputStream out = null;
        try {
            in = getContentResolver().openInputStream(uri);
            if (in == null) {
                throw new IOException("cannot open input stream");
            }
            out = new FileOutputStream(outFile);
            byte[] buffer = new byte[8192];
            int len;
            while ((len = in.read(buffer)) > 0) {
                out.write(buffer, 0, len);
            }
            out.flush();
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                }
            }
            if (out != null) {
                try {
                    out.close();
                } catch (IOException ignored) {
                }
            }
        }
        return outFile;
    }

    private void toast(String msg) {
        if (isFinishing() || isDestroyed()) {
            return;
        }
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }
}
