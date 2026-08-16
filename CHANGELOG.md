# 项目变更日志

## [v1.3] 2026-08-16 — 修复登录后闪退（已模拟器验证）

### 根因
`activity_main.xml` 中 `<RecyclerView>` 标签**未写全限定类名** `androidx.recyclerview.widget.RecyclerView`，运行时被当作 `android.view.RecyclerView`（不存在）→ `ClassNotFoundException` → `InflateException` → MainActivity 启动即崩。编译期不校验 XML 类存在性，静态审查漏掉，仅运行时暴露。

### 变更
- 修复 `activity_main.xml` 的 RecyclerView 全限定类名
- 全量扫描其余布局，无其他未限定自定义视图
- **实证验证**：装 AEHD 硬件加速驱动（AMD-V），模拟器（Android 11）上完整复现「登录后闪退」并抓取 logcat 定位根因；修复后重装验证登录 → 目录浏览全链路通过
- 产出 app-debug.apk（7.0M），截图 `android_client/docs/emulator_verified.png`

## [v1.2] 2026-08-16 — 安卓客户端修复与体验改进

### 变更
- **登录后闪退取证**：App 加全局崩溃捕获，堆栈写入 `Android/data/com.ftpweb.client/files/crash_log.txt`
- **协议自选**：登录页加 http/https RadioGroup，域名框只填 IP:端口，自动拼 baseUrl 并剥手敲前缀
- **域名与账号分离**：删除 ConfigManager，新建 `ServerConfig`（协议+host，普通存储）与 `AccountStore`（凭据，加密存储）
- **安全提示**：选 http 时显示明文传输风险警告；cookie 改用 hostOnlyDomain + path("/")
- 注意：升级后需**重新输入一次域名与账号密码**（存储文件已拆分）
- 已 `assembleDebug` 构建通过，产出 app-debug.apk（7.0M）

## [v1.1] 2026-08-16 — 新增安卓客户端

### 变更
- 新增 `android_client/` 独立子文件夹：原生 Java 安卓客户端，复用 web 端接口
- 功能：域名可配置、账号密码加密保存（EncryptedSharedPreferences）、RSA 登录、目录浏览/进入/上传/下载/删除/重命名/新建文件夹/登出
- 技术：Java + OkHttp + Gson/org.json + Gradle 8.4 wrapper + AGP 8.2.2，本地命令行构建
- 沉淀 4 条项目级经验（RSA 跨端格式/session cookie/明文 HTTP/配置接线闭环）

### 构建验证（2026-08-16）
- 安装本地安卓工具链：JDK17、Android SDK（cmdline-tools/build-tools 34/platform-tools）、Gradle 8.4，写入 JAVA_HOME/ANDROID_HOME/用户 PATH
- 修复构建期问题：图标引用改为应用内矢量；gradle-wrapper.jar 补 Main-Class；distributionUrl 改腾讯镜像
- `gradle assembleDebug` 与 `gradlew` 均构建成功，产出 `android_client/app/build/outputs/apk/debug/app-debug.apk`（6.9M）

## [v1.0] 2026-08-16 — 项目初始化

### 变更
- 初始化项目结构，接入 AI 规则仓库（结城希亚人格模板 + 神器使团团队风格）
- 创建主规则文档 CLAUDE.md（项目概述、硬约束、主Agent配置、Agent团队、任务执行指引、权限规则、同步机制）
- 创建 4 个子Agent角色文件（.claude/agents/）
- 启用 Spec 管理（.claude/specs/）
- 部署命令：z-commit、z-explore、z-task、z-rules-sync、z-run
- 配置 UserPromptSubmit hook（.claude/settings.json）
