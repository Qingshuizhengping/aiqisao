# 内部助手部署与恢复

目标地址为 `https://8.134.141.217:6069`，Nginx 在 6069 端口终止 TLS，应用只监听 `127.0.0.1:3001`。员工版独立于现有公网应用，代码、Unix 用户、服务、端口、数据库、Cookie、日志、缓存及备份目录均须分开。本文件提供可执行流程；不会因为脚本成功就视为网络入口、TLS、离机保护或生产验证已经完成。

## 部署前置条件

- IP 入口必须使用包含 `8.134.141.217` IP SAN 的可信证书。当前可复用服务器的专用 IP 证书；正式发布前检查完整链、到期时间、自动续期与 Nginx 重载钩子。将来使用域名时另行确认 DNS、接入与对应域名证书。
- 在实际目标 Linux 上使用 Node.js 24 LTS，重新执行 `npm ci`，不要复制 Windows 的 `node_modules`。`better-sqlite3` 为本机原生依赖。依赖安装、构建及测试都应使用普通部署用户。
- 新建无交互登录的专用服务用户 `wzy-internal`；示例代码位于 `/opt/ai-qisao-internal/current`，持久数据 `/var/lib/ai-qisao-internal`，本地备份 `/var/backups/ai-qisao-internal`。数据与备份目录由该用户拥有且为 `0700`。代码由部署用户拥有，服务用户只读代码；`.env` 对服务用户只读且权限 `0600`，不要进入 Git 或 Web 静态目录。
- 安全组及系统防火墙仅开放需要的 SSH、HTTP/HTTPS 和员工版 HTTPS 6069；3001 不对公网开放。模型供应商凭据仅放独立环境配置，按内部版单独配额。不要把公网应用密钥、数据库或会话迁入内部版。

从 `internal/.env.example` 创建 `.env`。`INTERNAL_DATA_DIRECTORY`、`INTERNAL_BACKUP_DIRECTORY`、`BACKUP_EXPORT_DIRECTORY` 的相对路径均以 `internal/` 为基准。建议使用上述独立绝对路径。`INTERNAL_ENCRYPTION_KEY` 和 `BACKUP_ENCRYPTION_KEY` 必须是分别生成的 32 字节标准 base64 值，不要复用；可在受限终端使用 `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"` 生成，再存入受限环境文件与独立密码库。环境文件、历史加密配置和备份解密密钥也需要独立安全备份。历史 TOTP 字段保留以兼容旧快照，当前登录不再使用它们。

### 回答模式、搜索与生图配置

v2 新增下列变量，全部可选；不配置时功能各自降级，不影响启动（由 `createConfig` 校验取值，非法值启动即抛错）。

| 变量 | 默认值 | 作用与降级行为 |
| --- | --- | --- |
| `INTERNAL_GROUNDING_MODE` | `free` | `free` = 开放回答（检索为空也照常回答）；`strict` = 回滚到四阶段依据核验。只允许这两个值，写错启动即失败。`/api/health` 的 `grounding.mode` 反映真实模式。 |
| `INTERNAL_CHAT_BREAKER_COOLDOWN_MS` | `3000` | 存储失败熔断的冷却窗口（50–600000）。熔断打开后 `/api/chat/runs` 返回 503 + `Retry-After`，冷却到期自动探测恢复，**不需要重启进程**。 |
| `INTERNAL_SEARCH_PROVIDER` | 空 | 搜索 provider slug。留空（或 key 为空）= 静默降级为无搜索：不发任何外部请求，前端不显示“允许联网搜索”开关。当前只实现了测试用的 `stub`；`tavily` 为骨架，配置后只会降级、不会外发。 |
| `INTERNAL_SEARCH_API_KEY` | 空 | 与 provider 同时存在才启用搜索。 |
| `INTERNAL_SEARCH_BASE_URL` | 空 | 可选，必须是纯 HTTPS origin（无凭据/查询/片段）。 |
| `INTERNAL_SEARCH_TIMEOUT_MS` | `8000` | 搜索超时（1000–30000）。超时按“降级”处理，回答照常。 |
| `INTERNAL_SEARCH_MAX_RESULTS` | `5` | 每次最多引用条数（1–10）。 |
| `INTERNAL_IMAGE_API_KEY` | 空 | 混元生图密钥。**留空 = 素材生成不可用**：`/api/images/options` 返回 `enabled:false`，提交返回 503 `IMAGE_NOT_CONFIGURED`，不影响其他功能。 |
| `INTERNAL_IMAGE_MODEL` | `hy-image-v3.5-preview` | 模型名，须匹配 `^[a-z0-9][a-z0-9.\-]{2,63}$`。 |
| `INTERNAL_IMAGE_API_BASE` | `https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation` | 必须是 HTTPS origin。 |
| `INTERNAL_IMAGE_TIMEOUT_MS` | `150000` | 上游同步返回，默认 150 秒（5000–180000）。 |
| `INTERNAL_IMAGE_CONCURRENCY` / `INTERNAL_IMAGE_QUEUE_CAPACITY` | `2` / `8` | 全局并发与排队上限；排队满返回 503 `IMAGE_QUEUE_FULL`。 |
| `INTERNAL_IMAGE_MINUTE_LIMIT` / `INTERNAL_IMAGE_HOUR_LIMIT` | `5` / `30` | 每账号限流；超限返回 429 `IMAGE_RATE_LIMITED` + `Retry-After`。 |
| `INTERNAL_IMAGE_DIRECTORY` | `<数据目录>/images` | 图片落盘目录，**必须位于 `INTERNAL_DATA_DIRECTORY` 之下**，否则启动即失败。 |

v1 的严格模式布尔开关已物理删除：升级时如果旧 `.env` 里还留着那一项，它会被忽略，回答模式只由 `INTERNAL_GROUNDING_MODE` 决定。旧字段名在代码、测试与文档中已零命中，可作为升级后的一致性检查（`grep` 一下就应无输出）。

初次启动仅在用户表为空时创建初始管理员。初始密码至少 6 字符，允许纯数字，首次登录必须改密。所有角色仅使用账号和密码登录，历史 TOTP 绑定已退出验证流程。启用后再验证账号停用、删除与恢复、项目移除、管理员只读审计和普通成员边界。用户表非空时变更初始配置不会重置任何账号。

在 `internal/` 执行：

```sh
node --version
npm ci
npm test
npm run build
```

示例 systemd 服务；`/usr/bin/node` 必须确实为 Node 24，按实际安装位置替换：

```ini
[Unit]
Description=Weizhiyu Internal Assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=wzy-internal
Group=wzy-internal
WorkingDirectory=/opt/ai-qisao-internal/current/internal
EnvironmentFile=/opt/ai-qisao-internal/current/internal/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/ai-qisao-internal
LimitNOFILE=4096
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

日志只记录状态与错误码，不记录聊天正文、提示词、密码、Cookie、TOTP 或供应商密钥；反向代理不要记录请求体或鉴权头。SQLite 位于本机持久磁盘，不能把运行中的主库放到不支持 SQLite 锁语义的网络共享上。只运行一个工作进程；当前任务调度及订阅不支持多进程共享一个数据库。

## HTTPS 反向代理与证书

Nginx 单独建立 6069 server，不修改现有公网应用站点。HTTPS 内的关键代理配置：

```nginx
server {
    listen 6069 ssl;
    server_name 8.134.141.217;
    ssl_certificate /etc/letsencrypt-aiqisao/live/aiqisao-ip/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt-aiqisao/live/aiqisao-ip/privkey.pem;
    client_max_body_size 11m;
    error_page 497 =308 https://8.134.141.217:6069$request_uri;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        # 素材生成是同步上游（最长 150 秒），代理读超时必须大于 150 秒；
        # 15m 已足够，不要为了“更安全”调到 60s，否则大图会 504。
        proxy_read_timeout 15m;
    }
}
```

先做 Nginx 配置检查，再 reload。`NODE_ENV=production`，`INTERNAL_ORIGIN=https://8.134.141.217:6069` 必须精确包含端口；不要为方便调试放宽 Origin/CSRF 或关闭 Secure Cookie。原 80/443 站点和 IP 证书挑战路径继续沿用现有配置。确认服务器时间同步，以正确校验会话有效期和备份时间。专用 IP 证书续期 timer 与部署钩子须正常，钩子应先 `nginx -t` 再 reload；浏览器成功访问不代表自动续期已配置。短期 IP 证书需要持续续期，不能忽略到期监控。旧 HTTP SSH 隧道只供运维检查，员工登录使用 HTTPS 6069。

## 在线备份与离机导出

`npm run backup` 使用 SQLite online backup API 读取正在运行的主库，包含已提交 WAL 内容；不会通过直接复制 `internal.sqlite` 漏掉 WAL。生成完整快照后执行 `integrity_check`、`foreign_key_check` 和核心表检查，写入 SHA-256 与表行数清单，文件权限为 `0600`。本地成功备份保留 14 天，仅清理本工具生成且时间早于保留期的文件；其他文件不会被清理。保留期依赖系统时钟，需维持时间同步。

**图片文件不在备份范围**：`var/images/`（或 `INTERNAL_IMAGE_DIRECTORY`）里的生成图片是磁盘文件，不属于 SQLite，`npm run backup` 与加密离机导出**都不会包含**它们。恢复演练/正式恢复后，数据库里的 `image_jobs` 记录仍在，但文件缺失的下载会返回 `410 IMAGE_FILE_MISSING`（前端提示“图片文件已不存在，请重新生成”）。如果业务要求保留素材，必须单独备份该目录（例如 `rsync`/对象存储），并在恢复演练里用“历史可见但需重新生成”的结果作为预期。

| 配置 | 含义 |
| --- | --- |
| `INTERNAL_DATA_DIRECTORY` | 主库所在目录，默认 `./var`；主库名 `internal.sqlite` |
| `INTERNAL_BACKUP_DIRECTORY` | 本地备份目录，默认数据目录下 `backups`；生产示例可设 `/var/backups/ai-qisao-internal` |
| `BACKUP_ENCRYPTION_KEY` | AES-256-GCM 用的独立 32 字节标准 base64 密钥 |
| `BACKUP_EXPORT_DIRECTORY` | 可选离机存储的挂载目录，例如已挂载远端存储的 `/mnt/internal-backup-export`；未配置不会生成离机副本 |

```sh
npm run backup
node scripts/backup.mjs --database /var/lib/ai-qisao-internal/internal.sqlite --directory /var/backups/ai-qisao-internal
```

若指定 `BACKUP_EXPORT_DIRECTORY` 却未提供有效密钥，备份命令直接失败；不会输出假成功。提供两项配置后会将已验证快照加密为 `.sqlite.enc`，格式为版本标识、随机 12 字节 nonce、密文和 16 字节认证标签，使用 AES-256-GCM。密钥不会作为命令行参数、日志或备份文件的一部分。导出目录必须是专用私有目录；脚本会拒绝符号链接、文件系统根目录以及 Linux 上权限过宽的目录。

**未配置导出时，日志明确输出 `offsiteProtection: not_configured`：这不满足离机保护。** 导出成功也只报告 `offsiteProtection: unverified`；另一目录、另一文件系统或同一云主机上的另一块盘均不能自动证明离机。运维必须用挂载信息核实该路径确实来自独立远端存储，并在远端查到相应加密对象及版本/保留策略，再从远端下载一份执行下述恢复演练。不要把“已挂载”误当成已经验证的离机恢复能力。脚本不删除远端导出，远端生命周期策略至少保留 14 天，并应具备独立访问控制或不可变版本。离机密钥需存到另一受控系统，不与备份文件仅放在同一台服务器上。

每日以专用备份用户或服务用户运行一次，使用 systemd timer 或现有调度系统；调度必须加载与当前版本相同的受限环境文件，设置 `UMask=0077`，仅允许读取数据目录及写入备份/导出目录。对失败退出码、剩余磁盘空间、超过 26 小时未产生新成功快照、远端对象缺失及恢复演练失败配置通知。目录不存在时脚本不会自动替运维挂载远端存储；备份调度前使用 `mountpoint`/`findmnt` 检查预期挂载，挂载缺失应失败，避免文件落到挂载点下的本机磁盘。

## 恢复演练与正式恢复

先完成一次部署目标 Linux 上的演练，再按月至少一次执行；演练优先使用从独立远端取回的加密文件。不使用真实供应商接口，脚本不会启动应用或调用模型：

```sh
node scripts/restore-check.mjs --input /path/to/internal-TIMESTAMP-UUID.sqlite.enc
node scripts/restore-check.mjs --input /path/to/internal-TIMESTAMP-UUID.sqlite --directory /var/lib/ai-qisao-internal/restore-drill --keep
```

加密输入需要同一 `BACKUP_ENCRYPTION_KEY`。命令在独立目录解密/复制，验证 GCM 标签（加密文件）、SQLite 完整性、外键、核心表和表行数；明文输入有配套 `.json` 时也检查 SHA-256、大小和行数。密钥错误、截断、篡改或校验失败会非零退出并移除失败的明文输出。默认演练完成即移除临时数据库；`--keep` 保留验证后的数据库并输出 `restoredPath`。原主库始终不会被覆盖。明文清单不是防篡改签名；需要可认证备份时使用 GCM 加密副本。

正式恢复由运维在维护窗口完成：

1. 停止内部助手及备份调度，保留当前整个数据目录的只读事故副本，包含 WAL/SHM；不要仅移动 `.sqlite` 后继续运行。
2. 在独立私有目录用 `restore-check --keep` 校验选定快照，确认时间、原始聊天/审计记录的行数、项目和记忆范围。保留与该快照匹配的 `INTERNAL_ENCRYPTION_KEY`。
3. 使用匹配版本的代码，在停机状态把恢复后的 SQLite 安装到新的数据目录，设定专用用户所有权和 `0600` 权限。不要让旧 WAL/SHM 与恢复库混用。将服务的数据路径切换至该新目录，保留原目录以便回退。
4. 启动前撤销恢复库全部旧会话：对恢复后的库执行 `DELETE FROM sessions`。使用管理员原有密码重新登录；历史 TOTP 字段仅为旧数据兼容保留，不再要求验证码。若密码无法验证，应启动组织规定的账号恢复流程。
5. 启动服务并检查健康状态。原有未完成任务（聊天与素材）由启动恢复逻辑标为中断，不自动重新生成或重复计费；素材会标为 `IMAGE_JOB_INTERRUPTED` / `IMAGE_JOB_CANCELLED`。若同时恢复了 `images/` 目录，抽查一张历史图片能下载；未恢复该目录时确认下载返回 410 且前端给出重新生成提示（这是预期行为，不是故障）。
5.1 `/api/health` 应同时包含 `grounding.mode`、`search.enabled`、`chat.breaker`、`images` 四段；`chat.breaker.state` 应为 `closed`、`lastError` 为空或为上次异常的错误码。核实普通成员、项目管理员、系统审计、删除记录和私有记忆隔离，再恢复入口与备份调度。实际演练记录日期、输入快照、校验结果、耗时和恢复点，不记录正文或密钥。

## 升级与回滚

XLSX 列坐标解析修复附带 `npm run repair:xlsx -- --database /opt/ai-qisao-internal/data/internal.sqlite --receipt-directory /opt/ai-qisao-internal/data/maintenance-receipts`。先做一致性备份并停止应用，再以服务用户运行该命令，完成后启动应用处理新排队的索引。命令本身只本地解析，不请求模型；索引由应用按既有配置处理。逐文件事务保留原件、更新版本及分段，失败文件保留旧内容，删除文件跳过、归档项目延后；私有收据记录摘要、版本和结果，支持重复执行与中断恢复。命令退出非零时先检查受限收据再重试，不用旧数据库覆盖新增业务数据。当前发布脚本已在切换后、启动新服务前执行该步骤。

本次服务器发布脚本为 `scripts/publish-server.sh`，通过既有 SSH 连接在服务器执行。其参数是 `/tmp/aiqisao-employee-COMMIT.tgz`，由对应提交执行 `git archive --format=tar.gz --output=release.tgz COMMIT internal` 生成并上传（v2 起 Markdown 渲染器与站点样式已内置在 `internal/`，发布归档不再包含兄弟参考项目）。脚本校验归档路径、可信 IP 证书和端口，使用专用用户安装依赖、运行测试及构建，等待后台任务结束、备份数据库与旧配置，再切换版本、精确更新 HTTPS Origin 并重启 PM2。失败时恢复旧代码、环境和 6069 站点配置；不会覆盖持久数据库或输出模型凭据。

服务器目标为既有 `/opt/ai-qisao-internal`、`qisao-internal` 用户和 `ai-qisao-internal` PM2 进程；首次部署需先完成账户、服务环境文件、数据库、可信 IP 证书与定时备份设置。脚本不自动获取阿里云账号权限或绕过云安全组。发布后应从外部网络验证 6069 可达、完整 TLS 验证通过以及匿名 API 被拒绝。

发布使用版本化只读目录和 `current` 指针；数据及备份不在发布目录内。升级前运行测试/构建，执行并校验一次备份，保留旧代码版本及其运行配置。先在相同 Node24 Linux 环境的隔离实例验证，使用合成账号和独立端口/目录；不得把生产数据库交给公网应用或让测试请求发送真实内部内容到供应商。

先停止服务，再切换代码并启动；检查 `/api/health`、HTTPS、Cookie、密码登录、控制面板、SSE、后台任务与角色边界。回滚只可在旧代码兼容当前 schema 时切回旧版本；存在不兼容数据变更时按恢复流程选择升级前快照，明确会失去快照后的写入。不要在服务运行时覆盖数据库或任意删除 WAL。确认新版本稳定且备份可恢复后，再按保留策略清理旧发布目录。

本地自动化测试只能证明代码路径；生产上线还须留存实际 Linux 测试、离机取回恢复、TLS/续期检查及单次合成模型调用结果。尚未执行的验证必须明确标为未完成。
