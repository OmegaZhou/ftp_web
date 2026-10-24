# 项目变更日志

## [v1.8] 2026-10-24 — 统一旧网页入口（待发布）

- `/ftp/login.html` 与旧工作台统一 302 重定向到 `/ftp/app/`；保留现有 `/ftp`、`/ftp/` 跳转，GET/HEAD 及带查询参数的访问均指向固定新版地址。
- 旧 `/ftp/api/*` 不纳入网页跳转，保留 Android RSA 表单/JSON 登录、`connect.sid` 及目录/当前路径 JSON 响应；新增对应路由回归，不修改 Android、Nginx 或用户数据。

## [v1.7] 2026-10-24 — 正式 Web、可靠传输与实测发布

### 变更
- React / TypeScript 正式工作台接入真实 FTP：目录浏览、搜索排序、虚拟列表、文件操作与下载；文件夹清单、空目录、冲突预检、可取消扫描。
- tus 顺序分块、客户端 Worker 完整摘要、SQLite 持久任务、异步校验和 FTP 后台转存；支持暂停、续传、重选原文件、重启后重新授权与真实两阶段进度。
- 保留旧 Android RSA 登录、connect.sid 与 API envelope；旧 Web 工作台重定向到新界面。修复请求挂起、特殊文件名、路径/符号链接、队列取消竞态和临时文件清理边界。
- 资源门覆盖用户/全局配额、磁盘预留、校验中的文件、FTP 第二份及旧上传预约；同一持久目录限制单个服务进程。生产缺少会话密钥或显式分块值拒绝启动。
- 新增魔女长裙、夏夜浴衣、冬日学院大衣及藏书阁、庭院、雪日阅读室，共六套立绘、六场景；迁移可拖动六姿势 Q 宠、动态开关和专注模式。原始制作图不进入发布包，主立绘没有持续缩放或滤镜。

### 验证与边界
- 最终代码 `6bfea50d88326cce71e721853fcb2698b751d7fb` 已推送 GitHub 并部署于 `https://playerzhou.com/ftp/app/`；实测选择 4 MiB，公网配置为 `measured`、报告 ID `hostdare-20261024-v1`。本轮部署、实测、发布冒烟与临时测试清理完成。
- 最新后端 19 项真实回环 FTP 集成、前端既有 30 项行为测试、类型检查和生产构建通过，修复通过独立审查；传输中心包含批量暂停/继续/重试及批次汇总。审查与验证统一记录在 [task_001](.codex/tasks/task_001/task.md)。
- 隔离 1 GiB tus → FTP 正式文件成功，独立 FTP RETR SHA-256 与源一致。实际浏览器已验证登录、特殊字符目录创建/重命名/下载、服务重启重新授权、换装与 Q 宠。
- 用户授权的临时账号已隔离验证；`bb4aeca` 完成 4/8/16/32 MiB 粗筛、4/16 MiB 各三次复测及 4 MiB 的 1 GiB 确认，均独立 FTP 回读摘要一致。4/16 MiB 吞吐中位数 4.78064 / 4.70344 MiB/s，选定 4 MiB；16 MiB 首轮目录 p95 +21.75% 越线记录保留。1 GiB 上传 4.03227 MiB/s、端到端 268.099 秒、目录 p95 +6.499%；证据见 [唯一实测报告](.codex/tasks/task_001/benchmark-20261024.json)。
- 新增 `UPLOAD_CHUNK_BENCHMARK_ID` 实测状态与发布工具可选报告 ID；systemd drop-in 管理 `MemoryHigh=256M` 并保留 `MemoryMax=384M`。粗筛与复测的 MemoryHigh 不同，资源结果分别记录，不混算。
- 修复真实 PATCH 中断后 HEAD 超时：改用 tus 公开 `handleWeb`，等待 DurableFiles 实际 finalizer 完成后处理已关闭响应，防止任务锁被响应发送永久占用；原间接依赖 `srvx@0.11.22` 改为显式依赖。最终 `6bfea50` 的隔离/公网 32 MiB 中断恢复分别验证 HEAD 约 340/151 ms，恢复与目标摘要通过；不把此验证冒充在最终 SHA 重跑完整性能矩阵。
- 未改 Nginx 或用户既有 Android 文件。Chrome 自动文件选择受扩展权限阻挡；浏览器上传闭环、真实关闭页面、触屏真机、完整故障矩阵和跨文件并发仍待验收。停止轮询 5 秒的接口测试不冒充浏览器关闭测试。
- 最终公网冒烟通过中文/空目录、64 KiB 文件上传及 FTP RETR/HTTP 下载双重摘要、rename、长度/Unicode 文件名、删除树和 logout。临时 FTP 账号删除后返回 530，原账号记录逻辑字节及其他当前记录不变；所属应用任务/暂存、隔离数据、临时凭据和私密备份均清理，Web/FTP 服务正常。

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
