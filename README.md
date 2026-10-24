# FTP Web · 云端资料室

基于 FTP 的文件工作台，使用 React / TypeScript 前端和 Express / SQLite 后端。新界面位于 `/ftp/app/`；旧 Android 使用的 `/ftp/api/` 保留兼容适配。

2026-10-24 已发布 `6bfea50d88326cce71e721853fcb2698b751d7fb` 至 [正式入口](https://playerzhou.com/ftp/app/)。分块经实网比较后选择 **4 MiB（4,194,304 字节）**，公网配置为 `measured`，报告 ID 为 `hostdare-20261024-v1`。本轮部署、实测、发布冒烟和临时测试账号清理已完成；未覆盖的浏览器与设备验收范围见下文。

## 本地运行

需要 Node.js 24.2 或更新的 24.x 版本，以及可登录的 FTP 服务。后端使用 Node 内置 SQLite，部分 Node 24 版本会显示实验性 API 提示。

```powershell
npm ci
npm --prefix web ci
npm run build
$env:FTP_HOST = '127.0.0.1'
$env:FTP_PORT = '21'
npm start
```

打开 `http://127.0.0.1:9090/ftp/app/`，使用 FTP 账号登录。默认只监听回环地址。前端开发可另开终端运行 `npm --prefix web run dev`，Vite 会把 `/ftp/api` 代理到本地 9090 端口。

## 已实现的行为

- 文件浏览、搜索、排序、分页、下载、新建目录、重命名与删除；上传和下载使用独立 FTP 连接。
- 文件/文件夹清单、同名预检、跳过/保留两份/明确确认替换。支持目录枚举的入口保留空目录；仅返回 FileList 的浏览器回退入口会提示空目录限制。
- tus 分块上传、暂停/继续、失败重试、偏移恢复、重选原文件及完整 SHA-256 校验。文件名、大小和修改时间用于查找候选，完整摘要用于拒绝选错文件。
- SQLite 持久任务、异步校验与后台 FTP 转存。写入任务专属临时文件后再提交正式名称；浏览器上传到 100% 不等于 FTP 已完成。
- 六套龙娘立绘、六个场景、可拖动的六姿势 Q 宠、换装偏好、动态开关与专注模式。主立绘保持原始分辨率，不做持续缩放或滤镜动画。素材来源、生成记录和体积见 [素材说明](web/public/art/README.md)。

**后台边界：**完整文件已校验并入队后，服务进程存活且 FTP 授权有效时可以关闭页面。尚未上传完或还需要客户端摘要的文件，关闭页面后需要重新关联本地文件。FTP 密码仅保留在服务进程内存；服务重启后任务和已收数据保留，需要再次登录授权。显式退出会撤销该账号的 FTP 授权。

## 配置与发布边界

| 环境变量 | 用途 |
| --- | --- |
| `HOST` / `PORT` | 默认 `127.0.0.1:9090` |
| `NODE_ENV=production` | 启用生产会话要求 |
| `SESSION_SECRET` | 生产必须提供稳定的会话密钥；不要提交到仓库 |
| `PUBLIC_ORIGIN` | 对外同源地址，例如 `https://example.com`，不含路径 |
| `FTP_HOST` / `FTP_PORT` / `FTP_TLS` / `FTP_ROOT` | FTP 地址、端口、显式 TLS 开关与允许根目录；默认 `127.0.0.1:21`、关闭 TLS、根目录 `/` |
| `FTP_WEB_DATA_DIR` | SQLite、tus 暂存及旧上传临时文件目录；本地默认 `.data` |
| `UPLOAD_CHUNK_SIZE` | 单次 PATCH 字节数，范围 1–64 MiB；生产必须显式设置，最终数值须由真实链路测试决定 |
| `UPLOAD_CHUNK_BENCHMARK_ID` | 可选的实测报告 ID；未设置时接口为 `benchmark-pending`，设置合法 ID 后为 `measured` 并回显 ID。仅在实际报告通过后设置；程序校验 ID 格式，不代替报告审查 |
| `UPLOAD_MAX_FILE_BYTES` | 单文件上限，开发基线 8 GiB |
| `UPLOAD_USER_QUOTA_BYTES` / `UPLOAD_GLOBAL_QUOTA_BYTES` | 活跃任务逻辑配额，开发基线 12 / 20 GiB |
| `UPLOAD_RESERVE_BYTES` / `UPLOAD_RESERVE_RATIO` | 空闲磁盘保留线，取两者较大值；开发基线 5 GiB / 20% |

实网通过现有 Nginx 完成 4/8/16/32 MiB 粗筛及 4/16 MiB 各三次 256 MiB 复测；吞吐中位数为 4.78064 / 4.70344 MiB/s，最终选 4 MiB。其 1 GiB 确认上传吞吐 4.03227 MiB/s，端到端传输 268.099 秒，独立 FTP 回读 SHA-256 一致；目录 p95 为 217.8161 ms，较同节奏空闲基线增加 6.499%。16 MiB 复测首轮 +21.75% 超标记录保留。正常矩阵运行于 `bb4aeca`；最终 `6bfea50` 另通过真实 PATCH 中断恢复回归。保留 Nginx 的 100 MiB 限制；[实测报告](.codex/tasks/task_001/benchmark-20261024.json)保存原始数据、版本及测量限制。

部署时将持久数据放入服务账号拥有的专用目录（例如 `/var/lib/ftp-web`），只为该目录补足 systemd 写权限，保留现有系统保护。SQLite 的数据库、WAL/SHM、上传文件必须一起保留；升级和回退不能清空数据。当前仅支持单个 Node 进程管理同一数据目录。旧 RSA 登录仍需要已有 `pri_key.rsa` / `pub_key.rsa`；不得覆盖线上密钥。旧 Web 入口重定向到新页面，避免继续暴露旧页面的文件名插值问题。

FTP REST 上传、下载 Range、线上 rename 覆盖行为和资源预算仍须针对实际服务验收。当前 FTP 失败会从服务器暂存重传，不要求浏览器重传；FTP 协议不能提供与外部写入者之间的原子 compare-and-swap，应用会在预检和提交前核对目标，仍需避免外部并发覆盖同名目标。

## 验证

后端集成测试使用 Python `pyftpdlib` 在随机回环端口启动隔离 FTP，生成临时账号和目录，不连接生产 FTP。

```powershell
python -m pip install -r test/requirements.txt
npm run typecheck
npm test
npm --prefix web test
npm run build
```

常规大文件测试为 129 MiB，通过真实 HTTP tus 请求转存，再使用独立 FTP RETR 计算摘要。可单独运行 1 GiB 验证：

```powershell
$env:FTP_TEST_LARGE_MIB = '1024'
node --test --test-name-pattern='large real request bodies' test/backend.test.ts
Remove-Item Env:FTP_TEST_LARGE_MIB
```

最新本地回归为后端 19/19、前端既有 30/30、类型检查及生产构建通过，修复通过独立审查。真实 PATCH 中断曾导致 HEAD 超过 20 秒等待，现已修复：等待数据写入 finalizer 完成后才释放任务锁，已关闭响应不再阻塞。新版本隔离/公网 32 MiB 恢复测试的 HEAD 分别约 340/151 ms，偏移恢复及独立目标摘要均通过。后台测试仅停止 HTTP 轮询 5 秒，不代替真实关闭浏览器验收；Chrome 自动文件选择权限、触屏真机、完整故障矩阵和跨文件并发选型仍未完成。阶段结果统一记录在 [task_001](.codex/tasks/task_001/task.md)。

## 服务器发布

`scripts/deploy.sh` 提供 `prepare`、`activate`、`rollback` 三个显式步骤，需在部署主机以 root 执行。`prepare <完整提交 SHA> <运行包路径> <运行包 SHA-256>` 校验归档并安装生产依赖，不切换服务。运行包只包含 Git 中的后端入口、锁文件、server/lib、旧登录所需资源及已构建的 `web/dist`，不能混入私钥、用户文件或制作源图。

发布目录位于 `/opt/ftp-web/releases/<SHA>`，原 `/opt/ftp_web` 保留；持久数据统一放在 `/var/lib/ftp-web`。`activate <完整提交 SHA> <块字节数> <实际 HTTPS origin> [实测报告 ID]` 通过专用 systemd drop-in 切换版本，保留原环境密钥、RSA 目录及系统保护，并管理 `MemoryHigh=256M`、保留 `MemoryMax=384M`。省略报告 ID 用于候选测试，完成报告后才通过可选第 4 参数写入实测标记。切换前备份配置，失败自动回滚；命令输出具体的 `rollback <备份目录>` 路径。回滚保留持久任务及暂存数据，不把数据库恢复到旧快照以免丢失新任务。不要对生产运行会替换 PAM 配置的旧迁移测试脚本。

最终发布冒烟通过中文目录、空目录、64 KiB 文件上传、独立 FTP 回读/HTTP 下载摘要、重命名、删除和退出授权。临时账号已删除并确认 FTP 530 拒绝登录；原有账号记录一致，测试任务、暂存、凭据、私密备份和服务器测试辅助文件均已清理。Web 与 FTP 服务运行正常，Nginx、PAM、FTP 配置、服务密钥和 RSA 未改动；详细证据与回滚目录见 [任务记录](.codex/tasks/task_001/task.md)。

粗筛时 `MemoryHigh=∞`，复测及 1 GiB 确认时为 256 MiB，两阶段资源数据分别记录；1 GiB 时 cgroup 峰值约 257.664 MiB、OOM 为 0，`MemoryHigh` 是软阈值，不能把它描述为未越过 256 MiB。
