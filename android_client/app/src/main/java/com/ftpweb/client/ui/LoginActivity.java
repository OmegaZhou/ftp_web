package com.ftpweb.client.ui;

import android.content.Intent;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import com.ftpweb.client.R;
import com.ftpweb.client.config.AccountStore;
import com.ftpweb.client.config.ServerConfig;
import com.ftpweb.client.net.ApiClient;

/**
 * 登录页：域名 + 用户名 + 密码 + 记住账号密码 + 登录。
 */
public class LoginActivity extends AppCompatActivity {

    private EditText etDomain;
    private EditText etUsername;
    private EditText etPassword;
    private CheckBox cbRemember;
    private Button btnLogin;
    private RadioButton rbHttp;
    private RadioButton rbHttps;
    private RadioGroup rgProtocol;
    private TextView tvHttpWarning;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_login);

        etDomain = findViewById(R.id.et_domain);
        etUsername = findViewById(R.id.et_username);
        etPassword = findViewById(R.id.et_password);
        cbRemember = findViewById(R.id.cb_remember);
        btnLogin = findViewById(R.id.btn_login);
        rbHttp = findViewById(R.id.rb_http);
        rbHttps = findViewById(R.id.rb_https);
        rgProtocol = findViewById(R.id.rg_protocol);
        tvHttpWarning = findViewById(R.id.tv_http_warning);

        ApiClient api = ApiClient.getInstance();

        // 恢复已保存的服务器 / 账号 / 密码
        ServerConfig sc = ServerConfig.getInstance();
        if ("https".equals(sc.getProtocol())) {
            rbHttps.setChecked(true);
        } else {
            rbHttp.setChecked(true);
        }
        etDomain.setText(sc.getHost());
        String baseUrl = sc.getBaseUrl();
        if (!TextUtils.isEmpty(baseUrl)) {
            api.setBaseUrl(baseUrl);
        }

        // http 为明文传输，选中 http 时显示风险提示，https 时隐藏
        rgProtocol.setOnCheckedChangeListener((group, checkedId) -> updateHttpWarning());
        updateHttpWarning(); // 按当前恢复出的协议立即刷新初始可见性

        AccountStore as = AccountStore.getInstance();
        etUsername.setText(as.getUsername());
        boolean remember = as.isRemember();
        cbRemember.setChecked(remember);
        if (remember) {
            etPassword.setText(as.getPassword());
        }

        // 已有会话则直接进入主界面；会话失效时 MainActivity 会跳回登录页
        if (api.hasSession()) {
            startActivity(new Intent(this, MainActivity.class));
            finish();
            return;
        }

        btnLogin.setOnClickListener(v -> doLogin());
    }

    private void updateHttpWarning() {
        tvHttpWarning.setVisibility(rbHttp.isChecked() ? View.VISIBLE : View.GONE);
    }

    private void doLogin() {
        final String user = etUsername.getText().toString().trim();
        final String pass = etPassword.getText().toString().trim();
        final boolean remember = cbRemember.isChecked();

        String protocol = rbHttps.isChecked() ? "https" : "http";
        String host = etDomain.getText().toString().trim();
        // 容错：若用户在 host 里手敲了协议前缀，剥掉
        if (host.contains("://")) {
            host = host.substring(host.indexOf("://") + 3);
        }
        if (TextUtils.isEmpty(host)) {
            toast(getString(R.string.login_domain_empty));
            return;
        }
        final String baseUrl = protocol + "://" + host;
        if (TextUtils.isEmpty(user)) {
            toast(getString(R.string.login_username_empty));
            return;
        }
        if (TextUtils.isEmpty(pass)) {
            toast(getString(R.string.login_password_empty));
            return;
        }

        // 禁用按钮防止重复提交
        btnLogin.setEnabled(false);
        btnLogin.setText(R.string.logging_in);

        ApiClient api = ApiClient.getInstance();
        api.setBaseUrl(baseUrl);
        ServerConfig.getInstance().setBaseUrl(baseUrl); // 持久化（自动拆协议 + 存 host）
        api.login(user, pass, new ApiClient.ApiCallback() {
            @Override
            public void onSuccess(String result) {
                if (isFinishing() || isDestroyed()) {
                    return;
                }
                AccountStore.getInstance().save(user, pass, remember);
                btnLogin.setEnabled(true);
                btnLogin.setText(R.string.login);
                startActivity(new Intent(LoginActivity.this, MainActivity.class));
                finish();
            }

            @Override
            public void onFailure(String message) {
                if (isFinishing() || isDestroyed()) {
                    return;
                }
                btnLogin.setEnabled(true);
                btnLogin.setText(R.string.login);
                toastLong(message == null ? getString(R.string.login_failed) : message);
            }
        });
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    private void toastLong(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
    }
}
