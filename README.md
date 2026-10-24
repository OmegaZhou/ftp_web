# FTP Web · 云端资料室

基于 FTP 的文件工作台，使用 React / TypeScript 前端和 Express / SQLite 后端。新界面位于 `/ftp/app/`；旧 Android 使用的 `/ftp/api/` 保留兼容适配。

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
| `UPLOAD_MAX_FILE_BYTES` | 单文件上限，开发基线 8 GiB |
| `UPLOAD_USER_QUOTA_BYTES` / `UPLOAD_GLOBAL_QUOTA_BYTES` | 活跃任务逻辑配额，开发基线 12 / 20 GiB |
| `UPLOAD_RESERVE_BYTES` / `UPLOAD_RESERVE_RATIO` | 空闲磁盘保留线，取两者较大值；开发基线 5 GiB / 20% |

当前开发候选块为 8 MiB，接口明确标记 `benchmark-pending`，**这不是正式选值**。真实客户端 → 现有 Nginx → VPS → FTP 的比较测试尚未完成，不能依据本地回环吞吐选择上线参数。保留 Nginx 的 100 MiB 限制；测试门与候选矩阵见 [任务方案](.codex/tasks/task_001/task.md)。

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

本地测试不替代现有 Nginx 链路测试、触屏真机验收或完整故障注入矩阵。阶段结果与尚未完成的发布门统一记录在 [task_001](.codex/tasks/task_001/task.md)。
