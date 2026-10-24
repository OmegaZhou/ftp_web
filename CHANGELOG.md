# 项目变更日志

## [v1.7] 2026-10-24 — 正式 Web 与可靠传输本地实现

### 变更
- React / TypeScript 正式工作台接入真实 FTP：目录浏览、搜索排序、虚拟列表、文件操作与下载；文件夹清单、空目录、冲突预检、可取消扫描。
- tus 顺序分块、客户端 Worker 完整摘要、SQLite 持久任务、异步校验和 FTP 后台转存；支持暂停、续传、重选原文件、重启后重新授权与真实两阶段进度。
- 保留旧 Android RSA 登录、connect.sid 与 API envelope；旧 Web 工作台重定向到新界面。修复请求挂起、特殊文件名、路径/符号链接、队列取消竞态和临时文件清理边界。
- 资源门覆盖用户/全局配额、磁盘预留、校验中的文件、FTP 第二份及旧上传预约；同一持久目录限制单个服务进程。生产缺少会话密钥或显式分块值拒绝启动。
- 新增魔女长裙、夏夜浴衣、冬日学院大衣及藏书阁、庭院、雪日阅读室，共六套立绘、六场景；迁移可拖动六姿势 Q 宠、动态开关和专注模式。原始制作图不进入发布包，主立绘没有持续缩放或滤镜。

### 验证与边界
- 后端 17 项真实回环 FTP 集成、前端 30 项行为测试、类型检查和生产构建通过；传输中心补齐批量暂停/继续/重试及批次汇总，并经过真实界面验证。审查发现的问题及最后增量验证统一记录在 [task_001](.codex/tasks/task_001/task.md)。
- 隔离 1 GiB tus → FTP 正式文件成功，独立 FTP RETR SHA-256 与源一致。实际浏览器已验证登录、特殊字符目录创建/重命名/下载、服务重启重新授权、换装与 Q 宠。
- 尚未部署；未改 Nginx 或用户既有 Android 文件。Chrome 自动文件选择受扩展权限阻挡，浏览器上传闭环仍待验收；真实链路选块、生产 FTP 能力/资源预算及触屏真机测试未完成。开发 8 MiB 仅为测试候选，未选为正式默认。

## [v1.6] 2026-10-23 — FTP Web 迭代方案与交互预览

### 变更
- 整理 [task_001 实施方案](.codex/tasks/task_001/task.md)，覆盖响应式文件工作台、文件夹上传、tus 续传、持久化后台任务、身份恢复、FTP 转存与旧 Android API 兼容。
- 保留 Nginx 100 MiB 请求体限制；块大小按真实链路测试后选择，记录候选、采集指标、资源预算、故障验证与选择门，8 MiB 不作为已定默认值。
- 本轮为方案及独立 UI 交互预览；生产功能尚未实现，benchmark 尚未运行，没有修改线上配置。原有未提交改动保留。
- 根据用户的二次元偏好更新同一 UI 预览：沿用原登录页角色插画，加入冰蓝/紫蓝陪伴视觉、移动横幅与可恢复的专注模式；角色反馈跟随演示任务状态，生产代码未变。
- 进一步按用户选定方向重做同一预览：海边学院整页场景、GPT 龙娘大立绘与右侧文件终端；提供晴昼/黄昏/星夜三场景、三套立绘和可互动 Q 版宠物，装扮与模式选择可恢复；按用户追加要求提供场景轻推/光点、Q 宠待机与点击跳跃、切换反馈，动态开关可保存并服从系统减少动态与页面隐藏暂停。素材为参考常见形象的 AI 同人演绎并署名原作者；本轮继续仅为可点击原型。按后续反馈移除主视觉角色名牌；为修复立绘动态模糊，取消主图持续变换与阴影滤镜，恢复原分辨率并改用高质量 AVIF。Q 宠升级为可自由拖动的根内浮层，提供六姿势图集、动作菜单、方向键/回角落、休眠/唤醒与可关闭自主活动，位置和偏好可恢复。

## [v1.5] 2026-08-17 — 下载反馈与进度界面

### 变更
- **修复「下载成功后没有反馈」**：根因是 Android 11 连续 Toast 竞争，成功 toast 被系统吞掉 → 改用 **Snackbar**「已下载到手机「下载」目录」（持久可见，MediaStore 路径含「打开」动作直达文件）
- **新增下载进度界面**：`ApiClient.download` 增加 `DownloadProgressListener`（字节+时间节流、主线程分发、写盘结束补报 100%）；MainActivity 显示进度对话框（ProgressBar + 百分比，成功/失败统一关闭）
- 清理死资源 `download_success`
- 幽灵审查通过；模拟器实证：下载到公共目录正常、成功 Snackbar 出现（t=2s 检测到）、300MB 大文件下载完整

## [v1.4] 2026-08-16 — 修复下载功能（无法下载）

### 根因
下载原写入 `getExternalFilesDir`（应用私有隐藏目录 `Android/data/...`），Android 10+ 作用域存储下用户不可见 → 报「无法下载」；且下载请求遇会话失效（HTTP 200 + `{"message":"Need login"}`）会被误写进文件并误报成功。

### 变更
- 下载改到**公共下载目录**：API 29+ 用 `MediaStore.Downloads`（免权限），API 24-28 用公共目录 + `WRITE_EXTERNAL_STORAGE`（maxSdkVersion=28）运行时权限
- `ApiClient.download` 改为写入 `OutputStream`，按 Content-Type 区分文件流与 JSON 错误响应，识别 "Need login" 走会话失效处理
- 修复下载流资源泄漏（out 全分支关闭）+ `getExternalStoragePublicDirectory` 判空
- 幽灵审查打回后修复，模拟器实证验证：下载到 `/sdcard/Download/` 且内容正确

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
