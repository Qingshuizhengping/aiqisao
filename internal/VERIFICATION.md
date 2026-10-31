# 内部验收记录

## 2026-10-31 · v2（R1 开放回答 / R2 素材生成 / R3 三条高危修复 / R4 共享项目）

服务版本 `internal-v20261031-1`。本轮为开发自测记录，**未发布**：以下数字全部来自本机 Windows 工作区，部署目标 Linux 需按 [DEPLOYMENT.md](DEPLOYMENT.md) 重新 `npm ci && npm test && npm run build` 后再复签。

### 一、测试基线与增量

| 项目 | 数值 |
| --- | --- |
| 动手前基线 | **223 pass / 0 fail**（约 14s） |
| 收口时全量 | **290 pass / 0 fail**（约 19s） |
| 增量 | **+67**，无删除、无跳过、无 todo |

新增/扩充用例分布：

| 文件 | 条数 | 覆盖 |
| --- | --- | --- |
| `tests/build.test.js` | 4 | 无兄弟目录引用（源码目录 + 全仓文档/脚本）、vendored 三件套与版本一致、lock 与 package.json 一致、真实构建产物与 NOTICES |
| `tests/grounding-mode.test.js` | 5 | 默认 free、显式 strict、注入 provider 不改模式、health 与实际一致、非法值抛错 + 冷却参数边界 |
| `tests/storage-breaker.test.js` | 6 | 5 次失败开熔断、指数退避上限、半开成功复位、半开失败重开、snapshot 形状、持续成功不堆积 |
| `tests/chat-recovery.test.js` | 3 | 5 次 SQLITE_BUSY → 503+Retry-After → 冷却后 202（不重启）、单次失败即恢复、lastError 保留 |
| `tests/evidence-summary.test.js` | 5 | 文件+记忆合并计数、纯模型知识无角标、网络与本地来源区分、degraded、空/畸形输入安全 |
| `tests/open-answer.test.js` | 11 | 空库也回答、角标数量一致、零 fetch 两例、stub ok、stub 超时降级、偏好持久化、两条提示词断言、偏好校验、旧库迁移、网络来源不跨账号 |
| `tests/images.test.js` | 18 | 6 尺寸 + auto、非法输入、幂等/冲突、限流、并发与队列、五类失败文案互异、结果未知不重试、账号隔离、重启保留、重启修复、下载头、build 安全、未就绪/文件缺失、未配 key、401 不登出、分页、job 视图、前端契约 |
| `tests/shared-projects.test.js` | 15 | 默认非共享、标记权限与可见性、归档拒绝、批量授权、幂等、不改原 admin、撤销审计、未共享拒绝、载荷校验、撤销即时、生成中撤销、停用可见性、成员只读、审计不含正文、前端契约 |

### 二、三次连续全量运行（无 flaky）

| 轮次 | 结果 | 耗时 |
| --- | --- | --- |
| 第 1 次 | 290 pass / 0 fail | 18.8s |
| 第 2 次 | 290 pass / 0 fail | 18.8s |
| 第 3 次 | 290 pass / 0 fail | 18.9s |
| 文档定稿后复查（连续 2 次） | 290 pass / 0 fail | 20.3s / 19.4s |

### 三、静态一致性检查

| 检查 | 结果 |
| --- | --- |
| 旧严格模式布尔开关的字段名（v1 遗留） | **0 命中**（代码、测试与文档都不再出现；`grep` 一下应无输出） |
| 兄弟参考目录的相对路径（`..` + 参考实现目录名 + `/`） | **0 命中** |
| `npm run build` | 成功，构建版本 `03d70ec68f9c` |

兄弟参考目录清零过程中修掉的三处（都不是代码依赖，但会让检索不干净）：

1. `scripts/publish-server.sh` 的归档白名单原本还允许兄弟参考目录的 `src/` 子树；v2 已把渲染器与样式内置，白名单收紧为只允许 `internal/`。**发布归档命令随之变化**：`git archive … internal`（不再带兄弟参考项目）。若沿用旧命令，脚本会以 `Unexpected archive path` 退出，不会产出一个半成品版本。
2. `DEPLOYMENT.md` 的发布命令说明同步改写。
3. `VERIFICATION.md` 的历史条目把头像来源写成“原项目 `public/static/img/…`”，不再带兄弟目录前缀（事实未变，仅去掉路径前缀）。

`tests/build.test.js` 已把这两个检查固化为断言：源码目录零命中 + **全仓**（文档、部署脚本、测试）零命中，后续有人写回旧路径会直接失败。

构建产物：

| 文件 | 大小 |
| --- | --- |
| `dist/index.html` | 1149 B |
| `dist/assets/app.js` | 187742 B |
| `dist/assets/style.css` | 94700 B |
| `dist/THIRD_PARTY_NOTICES.txt` | 2942 B（marked 18.0.9 MIT 原文） |
| `dist/` 合计 | 449 KB |

### 四、单目录构建实测（H2 的硬证据）

复制方式：`git ls-files internal | tar` → 只含被 Git 跟踪的文件（天然排除 `node_modules` / `var` / `dist` / `.graphify`），复制后 1.8 MB、22 个顶层条目。

| 尝试 | 命令 | 结果 |
| --- | --- | --- |
| 1 | Node 22.22.2：`npm ci` | **失败**（37.5s）。`better-sqlite3@13.0.3` 走 `node-gyp rebuild`，报 `gyp ERR! stack Error: Could not find any Visual Studio installation to use` |
| 2 | Node 24.15.0：`npm ci` | **失败**（6.8s），同一原因（`gyp ERR! find VS You need to install the latest version of Visual Studio`） |
| 3 | Node 22.22.2：`npm ci --ignore-scripts` + `npm run build` | **成功**：安装 76 个包 4.2s、构建 2.3s，产物与仓库内构建同版本号 `03d70ec68f9c`（css/js/id 一致），`dist/` 449 KB |

**结论与归因**：`npm run build` 这条链路（esbuild + 内置 vendor + `public/` 静态资源）**确实单目录自足**，不依赖任何兄弟目录，两次独立构建的产物哈希一致。`npm ci` 的失败是**本机环境**问题而非仓库缺陷：这台 Windows 机器没有 MSVC 构建工具链，`better-sqlite3` 也没有取到预编译二进制（两个 Node 版本都回退到源码编译）。目标 Linux + Node 24 的预编译覆盖需要在部署机上复验；`DEPLOYMENT.md` 已写明「在实际目标 Linux 上重新 `npm ci`，`better-sqlite3` 为本机原生依赖」。

**本轮同时修掉一个真实的部署级缺陷**：`package-lock.json` 里缺少 `marked@18.0.9` 条目（T01 只改了 `package.json`），导致任何干净目录执行 `npm ci` 直接 `EUSAGE: Missing: marked@18.0.9 from lock file`。已补齐锁条目（integrity 与 `third_party/README.md` 记录的上游哈希一致），并在 `tests/build.test.js` 增加「锁文件与 manifest 的直接依赖完全一致」的断言防止复发。若没做这次隔离实测，这个问题只会在真正发布时炸。

### 五、设计文档 §10.3 手工验收执行记录

| # | 项目 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | 单目录构建（复制到空目录 → `npm ci && npm run build`） | **部分完成** | 复制与 `npm run build` 已实测通过；`npm ci` 因本机缺 MSVC 失败（见上表），未绕过、未用 `--force` 伪装成功 |
| 2 | 真机生图（六档各出一张、关面板重开仍在、断网 10s 提示） | **未执行** | 本机没有 `INTERNAL_IMAGE_API_KEY`。能力由 18 条桩测覆盖（含六档请求体、两条取图路径、五类失败、重启恢复、下载头）；真实上游契约仍需一次真机联调 |
| 3 | 严格模式回滚（置 strict → 无依据提问返回不可核实；置回 free → 恢复） | **自动化覆盖，未真机** | `grounding-mode.test.js` 用真实 HTTP 请求断言两种模式的分支与 `/api/health` 一致；未在真机改 `.env` 重启验证 |
| 4 | 共享项目闭环（建项目→共享→授权→成员可见→成员 403→撤销消失） | **自动化覆盖，未浏览器手工** | `shared-projects.test.js` 15 条覆盖全部环节（含生成中撤销 1 秒内停止、已产出内容保留）；未做浏览器点击验证 |
| 5 | 熔断自愈（chmod 400 数据库 → 观察 open → 恢复权限 → 自动 200） | **自动化覆盖，未做 chmod 演练** | `chat-recovery.test.js` 用 `db.prepare` 注入 5 次 `SQLITE_BUSY` 走完整 503 → 冷却 → 202 流程；真实文件权限场景未演练 |

### 六、PRD 32 条逐条对账

统计：**已实现 28 条 / 降级实现 2 条 / 未实现 2 条**。

| ID | 优先级 | 状态 | 证据 / 说明 |
| --- | --- | --- | --- |
| R1-01 | P0 | 已实现 | `open-answer.test.js`「an empty library still produces a real answer with no fallback wording」 |
| R1-02 | P0 | 已实现 | `grounding-mode.test.js` 全 5 条；四阶段代码 `lib/grounding-*.js` 完整保留，只由 `groundingMode` 决定 |
| R1-03 | P0 | 已实现 | `evidence-summary.test.js` 5 条 + `open-answer`「a library-backed answer reports the same source count as its badge」+ `src/chat.js` 的 `evidenceRow()`（仅非审计视图） |
| R1-04 | P0 | **降级实现** | 规则已写进提示词并用断言固定（`open-answer`「the system prompt tells the model to flag volatile facts…」），但**没有真实模型 E2E**证明输出一定遵守；本机无模型密钥，自动化只能用模拟 provider。风险：提示词级保证 ≠ 行为保证 |
| R1-05 | P1 | **降级实现** | 适配层、零外发、清洗、超时降级、`/api/health` 标注全部实现并有 3 条用例；但**没有真实 provider**，只实现了测试用 `stub` 与 `tavily` 骨架（配置 `tavily` 只会降级）。设计 §U7 明确本轮只留骨架 |
| R1-06 | P1 | 已实现 | `open-answer`「turning search off in preferences persists, is echoed by /me and stops all fetching」+ `src/account.js` 仅在 `search.enabled` 时渲染开关 |
| R1-07 | P1 | 已实现（依赖 R1-05 降级） | `open-answer` stub 两条来源 + 超时降级；`evidenceSummary().network` 与「来自网络 N 条」角标区分资料来源；超时不留空引用块 |
| R1-08 | P2 | 已实现 | `evidence-summary.test.js`「network sources stay distinguishable from local sources」的 `items[].kind`（file/memory/network） |
| R2-01 | P0 | 已实现 | `images.test.js`「the panel wiring matches the agreed constants and the sidebar entry exists」+ `src/images.js`、`src/app.js` 侧栏入口；Esc/遮罩/焦点回归由既有 `ui.js:76-91` 提供 |
| R2-02 | P0 | 已实现 | `images.test.js`「all six size presets resolve and only auto omits the upstream size field」+「invalid sizes, blank prompts… are rejected」 |
| R2-03 | P0 | 已实现 | 状态存 SQLite；`images.test.js`「history and files survive a full service restart…」+ 前端 `loadHistory()` 重开恢复「生成中」 |
| R2-04 | P0 | 已实现 | `src/images.js` 结果区大图 + 下载（`downloadFile`）+ 再生成（新 `requestId`）；用例覆盖下载头与 job 视图 |
| R2-05 | P0 | 已实现 | `images.test.js`「a member only ever sees their own images」+「history and files survive a full service restart…」 |
| R2-06 | P0 | 已实现 | 「five upstream failure classes produce five distinct codes and user texts」+「a dropped connection marks the result unknown and is never retried automatically」 |
| R2-07 | P1 | 已实现 | `TEMPLATES` 5 条文案断言（产品平铺/海报竖版/贴片背景/门店场景/人物氛围）+ `.chip.active` 选中态 |
| R2-08 | P1 | 已实现 | 「a member may generate five images a minute and the sixth is rate limited」（含 `Retry-After`）；小时级计数同源实现，未单独用例 |
| R2-09 | P0 | 已实现 | 「downloads carry an inline-safe cache policy and a readable file name without the prompt」+「images live outside dist so a rebuild cannot delete them」 |
| R2-10 | P2 | **未实现** | 参考图（图生图）本轮不做；`image_jobs.reference_name` 字段已预留恒为 `NULL`，上游请求体不带 image part。原因：PRD 标 P2，设计 §1.3 明确排除 |
| R2-11 | P2 | **未实现** | 「插入对话」本轮不做。原因同上；面板只提供下载与再生成 |
| R3-01 | P0 | 已实现 | `storage-breaker.test.js` 6 条 + `chat-recovery.test.js`「five storage failures answer 503 with Retry-After, then the same request succeeds without a restart」；`/api/health` 的 `chat.breaker.lastError` 即 `lastStorageError` 等价字段 |
| R3-02 | P0 | 已实现 | `build.test.js` 4 条（含全仓零命中）+ 隔离目录构建实测（见第四节）；`npm ci` 部分受本机工具链限制，已如实记录 |
| R3-03 | P0 | 已实现 | `grounding-mode.test.js` 判定表 4 条 + 非法值抛错；`health.grounding.mode` 输出真实值，`transport-fixture` 措辞已删 |
| R3-04 | P1 | 已实现 | 223 → 290，全绿；三条修复各有专属文件，见第一节 |
| R4-01 | P0 | 已实现 | 项目信息里的「共享给团队」开关（仅 `writable` 时可改）+ `shared-projects.test.js`「only a project administrator can publish a project…」+「an archived project cannot change its shared flag…」 |
| R4-02 | P0 | 已实现 | 「creating an account can grant several shared projects at once」「re-submitting the same grants is idempotent…」「a project administrator is never downgraded…」 |
| R4-03 | P0 | 已实现 | `shared-projects.test.js` 第 15 条前端契约 + `src/shared-projects.js`（名称/成员数/角色/归档徽标/空态/点击进入） |
| R4-04 | P0 | 已实现 | 「inside a shared project a member has full chat access but no project administration」+ `src/projects.js` 成员视角不渲染设置/成员/归档 |
| R4-05 | P0 | 已实现 | 「revoking access takes effect immediately on every read path」+「revoking during a running answer stops it within a second…」 |
| R4-06 | P1 | 已实现 | 「an archived project cannot change its shared flag…」+ 归档共享项目聊天返回 409 `PROJECT_ARCHIVED`；面板显示「只读」徽标 |
| R4-07 | P1 | 已实现 | 复用 `assertProjectAdminRemovable`（`lib/access.js`）；「a project administrator is never downgraded…」证明控制面板不会删掉管理员关系 |
| R4-08 | P2 | 已实现 | 成员 `GET /members` 200、`PUT`/`DELETE` 403（R4-04 用例内四条 403 断言） |
| R4-09 | P2 | 已实现 | `project.share_update` + `admin.shared_project_sync`；「the audit trail records share changes and grants without any conversation content」dump 全表断言不含正文 |

### 七、仍存在的风险（如实列出）

1. **生图上游契约未真机验证**（R2 全部）。请求/响应形状照参考实现与设计文档写，两条取图路径都支持，但真实上游的字段漂移（`choices[0].delta.image` 是否稳定、402/401/422 的真实 status+code 组合）只能用桩测逼近。建议发布前做一次真机联调并把真实响应体固化为 fixture。
2. **`npm ci` 在本机无法完成**（缺 MSVC / 无预编译二进制）。构建链路已验证自足，但「干净机器一条命令装好」这件事尚未在 Linux + Node 24 上复签。
3. **R1-04/R1-05 的保证层级较低**：前者是提示词约束、后者是适配层骨架 + stub。真实回答风格与真实搜索结果质量都没有验证手段。
4. **图片不进备份**：`var/images/` 目前在备份与加密导出范围之外，`image_jobs` 记录会留下但文件缺失时下载返回 410。已在 DEPLOYMENT 明确写出，运维需要单独规划该目录的备份策略。
5. **熔断的半开探测复用调度读**：实现上简单可靠，但如果在「冷却刚好到期且队列为空」的时刻没有任何请求或定时器唤醒，`/api/health` 仍可能短暂报 not-ready 直到下一次调度（定时器会在冷却到期时主动唤醒一次，因此实际窗口极小）。
6. **搜索元数据在跨账号读取时被整体清空**（`status:'filtered'`），本项目管理员看不到成员回答引用了哪些网页。这是有意的隐私取舍，但如果产品后续要求「管理员可核查联网来源」，需要新的共享来源规则。


## 2026-10-30 · 自然聊天修正版上线与真实成文验证

通过阿里云命令助手 `t-gz071llnvcbjdvk` 发布 `8ff03de8eb2354820082834fba4c5c389a08cd34`，服务版本 `internal-v20261030-3`，前端 `5a770ed0f47f`。GitHub Linux 检查 `41052847103` 成功，服务器 223/223 测试与构建通过；一致性备份、版本切换及重启成功。上线后 22 项针对性回归、严格模式、TLS、匿名接口 401、人格私有路径 404、来源版本、数据库完整性和备份检查全部通过，原公网服务健康。

本次额外使用独立的虚构门店分工资料，通过生产 `createProvider` 和 `createGroundedAnswerService` 完成真实 `zai-org/GLM-5.3-Flash` 成文核验，共 2 次文字请求（草稿及语义核验），不读取员工聊天或客户资料，也不写入生产会话。核验后的回答保留“用流程代替盯人·用标准代替催促”等完整 DNA 表达，前台投影没有引用尾标，关键来源仍有效。部分候选被过滤后后台状态为 `partial`，页面不展示此内部状态；这项样例验证不等同于每次输出风格或事实的绝对保证。收据与原始合成回答保存在忽略目录 `natural-release-receipt.json`、`natural-model-result.json` 和 `natural-cloud-release-output.log`。加密导出仍在源文件系统，离机保护状态未变化。

## 2026-10-30 · 人格成文与自然聊天展示修正

上一版只验证了人格章节已发送，未验证最终成文。回答者原有“内部资料回答编辑”角色及确定性问候会弱化七嫂表达；本轮把完整表达 DNA 设为明确成文要求，普通中文总结采用短句对仗、先抓重点再拆动作，默认问候和自我介绍也使用七嫂口吻。风格不达标最多重写一次草稿，重写前重新验证来源，所有候选仍在展示前通过原有数值、完整引用及语义核验；不会在核验后自由润色。数字、制度原文、英文翻译和代码保留各自约束。

普通聊天隐藏核验标签、来源卡片和已知系统引用编号；显示与复制使用同一投影，已存在的旧消息同步按新规则展示。审计入口继续显示原始正文、状态和来源；代码、业务列表、转义方括号、用户原文与原文润色保持不变。

Windows Node 24.15.0 的 223 项合成测试全部通过，构建摘要 `5a770ed0f47f`。新增实际回答链路、一次风格重写、撤权前后竞态和引注投影回归。浏览器在桌面和 390×844 下验证普通聊天没有核验标签、来源卡片或生成引注，复制反馈正常；实际发送“你是谁”得到七嫂式介绍，审计仍可读取原文与引用。预览使用独立内存库和模拟供应商；真实模型成文验证及目标版本 `internal-v20261030-3` 的发布结果另记。界面证据：`output/playwright/natural-answer-clean.jpg`。

## 2026-10-30 · 七嫂人格已上线

阿里云命令助手成功发布 `48ea5c8d40510ee5b74029631af312a4c790be44`，线上版本 `internal-v20261030-2`，入口 `https://8.134.141.217:6069`，前端摘要保持 `77a65bba032c`。GitHub Linux 检查 `41031274644` 成功；服务器发布时 208/208 测试及构建通过，执行一致性备份、版本切换和重启。

独立核验命令 `t-gz071ljngpmiwow` 退出码为 0：7 个人格文件的 SHA-256 与已测试发布归档一致，原版内容仅按发布规则转换换行；运行提示词加载 5 个模型、9 条启发式和完整表达 DNA。生产文件上再跑 4 项模拟供应商测试全部通过，严格资料模式、TLS、匿名接口 401、人格静态路径 404、数据库完整性和外键检查正常。发布后备份完成并包含事实确认表，原公网服务健康。没有真实模型调用；加密导出仍在源文件系统，不等同于离机保护。忽略目录保存 `persona-cloud-publish-output.log`、`persona-cloud-postflight-output.log` 和 `output/playwright/persona-live-verified.png`。

## 2026-10-30 · 接入完整七嫂人格

找回的 `meiye-qi-sao-perspective` 原版主文件及 6 份研究资料复制到服务端 `skills/`，逐文件 SHA-256 与原件相同。共享人格模块加载 5 个心智模型、9 条决策启发式和完整表达 DNA，同时覆盖普通聊天及生产严格资料回答草稿；不加载原版身份扮演与联网研究流程。内部边界明确示例不是正式依据，不凭人格补写价格、用量、收益或效果，不冒充创始人。核验、标准事实提取和自动记忆整理继续使用专职提示词，关键值程序回填与原文引用保持原样，核验后没有新增自由润色。

Windows Node 24.15.0 的 208 项合成测试全部通过，构建成功，前端摘要仍为 `77a65bba032c`。新增 4 项检查覆盖真实供应商请求组装、两条聊天路径、核验及提取隔离、网页静态不可读取人格原件；所有测试均使用模拟供应商，没有真实模型调用。独立复核无阻塞问题。目标服务版本 `internal-v20261030-2`，线上发布结果另行记录。

## 2026-10-30 · 命令助手完成发布

已通过该实例预装的阿里云命令助手发布提交 `a529e0eee73af19ad7ca74cacfd9e1db94aeb76e`，服务版本 `internal-v20261030-1`，前端 `77a65bba032c`。控制台确认 SSH 服务运行且监听 22，防火墙该端口已启用；本机公网 SSH 握手仍被断开，本轮没有修改 SSH、防火墙或账号权限。

服务器从不可变 GitHub 提交获取源码，选取 112 个发布文件并逐文件计算摘要，换行恢复后的整体摘要与本机已测试归档一致。随后执行原发布脚本：Linux 204/204 测试通过、构建成功、等待原任务结束、一致性备份、版本切换、服务恢复与回滚准备均完成，云命令退出码为 0。

发布后独立验证 HTTPS 服务版本和提交、前端 JS/CSS 与本机构建逐字节相同，匿名来源/事实/控制面板接口均为 401，数据库 integrity/foreign-key 检查正常，发布后的加密备份包含确认及事实表。原公网应用健康，无真实模型调用。加密导出仍在服务器源文件系统；本轮因公网 SSH 链路未恢复，没有拉取新的离机副本，不能把本次本机备份状态称为已同步。执行结果保存在忽略目录的 `cloud-publish-result.log`、`cloud-postflight-result.log`，界面证据为 `output/playwright/answer-noise-live-verified.png`。

## 2026-10-30 · 简化回答中的内部提示

移除回答固定追加的“部分内容缺少充分依据，已省略。”，模型草稿与语义核验均不主动输出资料库口径冲突等内部工作说明，程序同时过滤此类诊断 claim。保留 partial/conflict 元数据、来源版本复核与不擅自选值的规则；明确要求比较资料时仍可列出有依据的不同记录。全部内容不可确认时给出简短回应，不产生空白回答或虚构结论。

历史消息仅作显示投影，隐藏独立诊断段及对应孤立引用，复制与可见正文共用同一投影。用户输入、原文润色、主动资料比较、代码示例与审计原文保留；混合业务段落不任意裁剪，数据库正文不改写。新增回归验证业务“字段冲突时联系管理员”不会被误删，用户明确“对比两份资料”不会被误认为无须比较。

Windows 204 项合成测试及构建通过，实际浏览器打开种子旧聊天，确认只显示有据业务正文与有效引用，复制按钮反馈成功；复制内容投影由纯函数测试核对，浏览器虚拟剪贴板不能回读原生复制内容。没有真实模型调用。界面证据：忽略目录 `output/playwright/answer-noise-clean.png`。本轮目标版本 `internal-v20261030-1`。阿里云 SSH 在密钥交换前被远端断开，尚未发布；线上仍为 `internal-v20261029-2`。

## 2026-10-29 · 严格依据资料回答

增加来源版本确认、标准事实候选与人工确认历史；重要字段由程序原样输出，受限计算采用定点整数。按全部授权已确认语料做名称、关键词及语义候选检索，不足时扩展一次。明确区分对象别称、零售/批发、规格、有效日期、完整适用条件和冲突，缺字段或检索故障不继续自由生成。旧自动记忆不会自动升级为权威事实。

模型草稿逐项绑定证据，程序校验数值、引用、完整原文段落与当前确认身份，再进行语义核验。核验前正文不写入 SQLite 或 SSE，只显示进度；来源编辑、删除、撤销后重确认、权限或归档变化均阻止旧任务发布。项目管理员读取同事聊天时继续过滤私人引用和计算依据。显式原文润色只核对本轮输入，历史 AI 回答不作为事实。

Windows Node 24.15.0 的 199 项合成测试通过，包含原 135 项回归和 64 项新增验证：全库超 12000 条召回、数字/单位/中文及 Unicode、多个对象/字段/版本、条件和历史有效期、无依据/冲突/故障拒答、草稿保密、停止/断线恢复、撤权竞态、供应商结构化响应、确认资料加密备份恢复及界面请求生命周期。修正测试中随机分配到浏览器禁用端口导致的偶发 fetch 失败，测试专用 loopback 请求改用原生 HTTP。

实际浏览器使用独立内存数据库和模拟供应商完成桌面与 390×844：确认来源、整理候选、逐条确认价格、泛问价格澄清、明确零售价后精确计算 168×3=504、打开引用版本与原文、核验进度到最终原文展示。手机页面宽 390px、弹窗宽 366px，按钮触控高至少 44px，无横向溢出。修正条件节点向原生 replaceChildren 传 false 导致的可见占位文字。截图位于忽略目录 `output/playwright/grounding-verified-mobile.png`、`grounding-source-mobile.png`、`grounding-quote-mobile.png`、`grounding-confirmed-desktop.png`。

本轮未调用付费模型。自由语义总结依赖模型核验，不能承诺绝对零错误；准确性仍依赖原始资料的正确性、完整性及维护。操作路径及明确边界见 [GROUNDING.md](GROUNDING.md)。发布使用 `internal-v20261029-2`，生产固定 strict 模式，上线不自动确认业务数据；一致性备份、GitHub Linux 检查及服务器发布检查沿用既有脚本。

## 2026-10-29 · 核心模块重构

统一实时有效账号、项目上下文和最后有效项目管理员规则，两个管理入口共用同一不变量。聊天服务拆为 HTTP/SSE 路由、会话业务与上下文、持久生成执行器，服务装配接口保持兼容。资料库拆为权限、存储、解析、任务和检索模块；已批准共享资料归项目使用，上传者停用、退出或删除后，当前项目管理员仍可重建索引与删除，候选和私人资料保留原作者门禁。

前端新增无 DOM 工作区控制器及生命周期工具，固定请求的账号、项目、会话和草稿归属。修复旧记忆 PATCH 覆盖新工作区、发送后切走再返回导致草稿复活的问题；清除草稿同时核验 key、内容和编辑 revision。导航仅释放观察，不停止后台生成。控制面板列表与编辑器独立持有请求生命周期。手机保留对话设置入口，已在 390×844 完成重命名与删除合成讨论。

修复 XLSX 稀疏列解析，空单元格、自闭合单元格、AA 列和展开文字限额都有回归。新增可重复执行的原文件修复命令，逐文件事务更新版本与分段、排队索引，保留原件，私有 intent 收据与运行锁支持幂等和崩溃恢复；命令不请求模型。发布脚本在备份、停止服务后运行维护，再启动队列。

本机 Node 24.15.0 完整测试 135/135 通过，构建版本 `0fa0749b72ee`，服务版本 `internal-v20261029-1`。合成浏览器验证旧会话发送、跨项目草稿保留、返回原会话同步完整 Markdown、手机聊天管理、共享资料上传与模拟索引失败后重试恢复、控制面板账号切换。桌面与手机无横向页面溢出，手机输入 16px，浏览器控制台无错误；供应商全部为模拟实现。

独立复核覆盖聊天与原实现兼容、私人来源过滤、共享资料授权和维护收据安全。正式发布前只读检查确认版本 6 服务正常、队列为空、XLSX 存量为 0、可信证书与续期正常。实际 GitHub 与服务器发布结果保存在发布回执，不能仅凭本节的本机验收认定线上已更新。浏览器证据：`output/playwright/employee-refactor-mobile.jpg`、`employee-refactor-desktop.jpg`（合成数据）。

## 2026-10-28 · 控制面板与密码登录

按用户要求移除登录页动态验证码和管理员绑定流程，所有角色（包括旧 TOTP 已绑定账号）统一使用现有账号密码登录。密码哈希和旧绑定字段不批量改写；旧绑定接口退役为已鉴权、CSRF 保护的 410 响应。初始改密、密码限流、HTTPS、Secure/HttpOnly Cookie、Origin/CSRF、即时撤权和审计继续保留。OTPAuth 运行依赖已移除。

新增独立的 `/admin` 控制面板和管理员侧栏入口，包含账号统计、搜索/角色/状态筛选、创建、编辑、系统角色、重置密码、停用、删除与恢复，以及集中分配每个项目的成员或管理员权限。账号删除为可恢复的停用，不删除聊天、记忆、资料与审计历史；恢复后保持停用。数据库兼容迁移增加 `users.deleted_at`，约束已删除账号不能处于启用状态；当前管理员与有效项目最后管理员受保护。

浏览器使用独立的内存数据库与合成账号，验证旧绑定管理员无验证码登录后直接进入面板、新增 6 位数字密码账号、分配项目成员权限、删除至回收站及恢复为停用。桌面与 390×844 手机复核无横向溢出，手机输入为 16px。修正旧列表请求与保存响应覆盖新表单的选择版本竞态，关闭面板和退出不会重新打开私密内容。浏览器无运行时错误，没有真实模型请求。

服务版本为 `internal-v20261028-6`，前端版本 `2d18ff23ebd8`。新的 100 项自动化覆盖密码登录、退役验证码接口、旧数据库迁移、控制面板权限、删除/恢复历史保留和现有聊天/记忆/资料功能。正式入口保持 `https://8.134.141.217:6069`，管理员入口为 `/admin`。以下各节记录旧版本在当时的验证要求，涉及 TOTP 的历史说明不再代表当前登录方式。

## 2026-10-28 · 原 AI 七嫂头像与 6069 发布

按用户最新要求恢复原 AI 七嫂头像，登录页、侧栏、欢迎区、聊天头像、favicon 和 PWA 图标均复用原项目已有图片。头像与原公网应用的 `public/static/img/avatar-192.png` 的 SHA-256 一致：`494d852a37cff20a4b992f26d49d0b9a6f67ac2f366e6d89731376f29cf016b7`；名称继续为“AI七嫂·员工专属版”。当前前端构建版本 `cb302df09fdd`，服务版本 `internal-v20261028-5`。

发布前本机 92/92 项测试通过，增加 HTTPS IP 端口 Origin、production 拒绝 HTTP 与 Secure/HttpOnly/host-only Cookie 验证。部署目标为 `https://8.134.141.217:6069`，后端继续监听 `127.0.0.1:3001`；保留现有账号、数据库与备份。使用服务器已配置的可信 IP 证书和续期重载钩子，开启 production，不关闭 Origin/CSRF 或管理员二次验证。发布脚本见 `scripts/publish-server.sh`，正式发布后另行记录 GitHub 提交与外部连通性回执。

Git 候选文件经过检查：不包含 `.env`、数据库、离机备份、恢复材料、生成目录或 SSH 凭据；测试中密钥形状字符串均为合成拦截样例。以下各节为历史发布记录，当时的私有入口和“未推送”状态不代表此次目标状态。

## 2026-10-28 · 名称恢复为 AI七嫂·员工专属版

当前名称统一为用户指定的“AI七嫂·员工专属版”，覆盖登录页、侧栏、聊天署名、输入区、图片替代文字、资料库提示、网页标题、PWA 完整和安装名称、模型身份提示及新绑定验证器的 issuer。用户提供的头像继续使用原文件；历史聊天正文不批量改写，已有账号、密码和验证器密钥不变。

本机与阿里云 Linux 各 89/89 项测试与构建通过，前端版本 `2c5066c5e4b6`，私有服务已更新为 `internal-v20261028-4`，健康检查正常。实际浏览器检查桌面与 390×844 手机布局，完整名称无横向溢出，手机侧栏关闭按钮保留 44px；私有入口刷新后已显示新名称。发布前完成一致性备份，公网入口仍返回 404。

## 2026-10-28 · 默认写入记忆与资料文件库

输入区的“写入记忆”复选框已从 DOM 移除。新讨论默认开启写入记忆；旧的可编辑讨论若关闭过此项，在下一次发送前自动启用。账号页主动关闭自动整理的偏好仍受服务端尊重。默认开启与完整回答后的后台记忆提取已通过集成验证。

记忆库新增“资料文件”页，可按个人、项目内个人、项目共享范围上传多文件、查看解析进度和纯文字、下载原文件、重试、删除与审核。支持 TXT、MD、CSV、JSON、PDF、DOCX、XLSX，每文件 10 MiB、20 万字符，PDF 最多 200 页，每范围 40 文件、每人原文件合计 200 MiB。扫描图片不做 OCR；旧版 DOC/XLS 与加密 PDF 暂不支持。任务与原文件在 SQLite 持久化，已有加密备份覆盖新表。

Windows Node 24.15.0 与阿里云 Linux Node 24.22.1 各 89/89 项测试通过，包含 7 类真实格式的合成解析样例、原始字节下载、来源引用、共享候选审核、归档只读、普通与审计权限隔离、删除与撤权竞态、凭据阻断、Office 展开/XML 限制、关键词降级和 SQLite 备份恢复。新增复核保证等待资料检索期间已删除的记忆不会继续进入模型上下文；项目管理员读取同事聊天时，消息、快照与 SSE 均不暴露私人文件片段。

实际浏览器用独立合成账号完成 Markdown 文件上传、解析完成、聊天自动检索、来源按钮预览和下载，下载文件 SHA-256 与上传样例一致。输入区复选框数量为 0。已修正预览条件节点误显示 `false`；桌面与 390×844 手机的深浅主题复核通过，页面与弹窗无横向溢出。手机资料入口、上传按钮与文件操作可用，格式说明折叠以减少滚动。没有真实模型或嵌入服务调用，模型测试全为模拟供应商。

已发布到私有服务 `internal-v20261028-3`，前端版本 `d8a824d17ab4`，健康检查与资料队列正常；公网域名入口仍返回 404，原公网应用健康检查正常。发布前已等待原任务结束并完成一致性备份，保留上一版本回滚路径。未提交或推送 GitHub。

合成数据界面证据：`output/playwright/xiaowei-knowledge-chat.jpg`、`xiaowei-knowledge-mobile-preview.jpg`、`xiaowei-knowledge-mobile-library.jpg`、`xiaowei-knowledge-library-light.jpg`。资料架构和限制见 `KNOWLEDGE.md`。

## 2026-10-28 · 参考界面风格更新

按照用户指定的 MeetingStudio 页面调整“小薇”内部版：中性灰白/炭灰画布、浮动侧栏、带内侧高光和柔和阴影的玻璃面板、鼠尾草绿主按钮、内凹输入框。登录、聊天、记忆、项目与管理界面使用同一组主题变量；头像、名称、密码规则和权限边界保留。参考页的实际浏览器截图和样式测量为依据，设计记录见 `DESIGN.md`。

样式分为 `src/base.css` 和 `src/studio.css`，由 `src/style.css` 依序加载。主题切换同步图标和浏览器 theme-color。修正移动端抽屉遮罩被旧 CSS 隐藏的问题；修正无 focusId 时空记忆库误获得高亮与滚动焦点的问题。

Windows 与阿里云 Linux 各 69/69 项测试通过，构建版本 `c6b1fb4b129a`，服务版本 `internal-v20261028-2`。私有部署健康检查正常，公网域名 HTTP 入口仍返回 404，原公网应用健康检查正常。发布前等待后台任务完成并生成一致性加密备份，最新加密副本已拉取到本机。未提交或推送 GitHub，没有调用真实模型。

浏览器使用独立合成账号和模拟供应商完成桌面 1280×720、手机 390×844、低高度 390×440 复核：明暗主题、流式 Markdown、记忆创建、项目切换、成员只读项目面板、账号页和退出均可用，无横向溢出。手机输入与消息字体为 16px；正常手机视口输入区底部 810px，低高度视口为 432px，均在视口内。遮罩可点击关闭导航抽屉。退出后消息 DOM 为 0。此为浏览器视口模拟，不替代实体 iPhone 键盘验证。

界面截图位于 `output/playwright/`：`reference-studio-light.jpg`、`reference-studio-dark.jpg` 为参考证据；`xiaowei-studio-desktop-dark.jpg`、`xiaowei-studio-desktop-light.jpg`、`xiaowei-studio-mobile-light.jpg`、`xiaowei-studio-mobile-memory.jpg`、`xiaowei-studio-mobile-dark.jpg`、`xiaowei-studio-project-dark.jpg` 为合成数据预览；`xiaowei-studio-private-login.jpg` 为部署后私有入口的匿名登录页。

## 2026-10-28 · 小薇与密码规则更新

助手名称已统一为“小薇”，包含登录页、侧栏、聊天署名、输入区、网页标题、PWA 名称与服务端系统身份。头像、favicon 和安装图标采用用户提供的 `1.1.png` 原图，透明度保留，源图与服务端文件 SHA-256 一致：`6497060d96887b517dcacbe29e95d7a2e2b8ebec0a95c92a8d68a572b884d29b`。

前后端密码要求统一为 6–256 个字符，允许纯数字。创建账号、首次改密、普通改密及管理员重置均已覆盖；5 位密码拒绝且不修改原哈希或会话，已有密码继续有效，管理员 TOTP 保留。Windows 与 Linux 各 69 项测试通过，构建版本 `bd2f3a43eee8`，服务版本 `internal-v20261028-1`。本次没有调用真实模型。

已更新私有服务并保留上一版回滚路径，公网入口仍返回 404，应用只监听服务器 loopback。现有账号、项目和聊天数据沿用原数据库。发布前已完成一致性备份并将加密副本拉取到本机。

实际浏览器使用合成账号完成了 6 位数字密码登录、首次改密和聊天；5 位新密码被原生表单校验拦截。390×844 下无横向溢出，输入区底部为 812px，退出后私密 DOM 和草稿清空。新头像在登录页和聊天区正常加载，截图为 `output/playwright/xiaowei-private-login.png` 和 `output/playwright/xiaowei-mobile.png`。

以下为 2026-10-27 首次验收的历史记录。

## 2026-10-27 · 首次内部验收

当前交付为仅通过 SSH 隧道访问的内部验收版。用户已明确要求“先不上公网”。`internal.weizhiyu.top` 的 Nginx HTTP 入口返回 404，HTTPS 拒绝握手，应用只监听服务器的 `127.0.0.1:3001`。

## 访问与首次设置

本机隧道入口为 `http://127.0.0.1:3187/`。HTTP 流量仅在电脑与服务器各自的 loopback 接口上传输，跨网络部分使用 SSH 加密隧道。当前环境使用严格 localhost Origin、HttpOnly/SameSite Cookie；只为本机验收关闭 Secure 标志。正式发布必须切回 production HTTPS 配置、Secure Cookie，并重新验证域名证书和接入状态。

本机的受限目录 `C:\Users\weizhiyu\.codex\secure\aiqisao-internal` 保存启动脚本、初始账户文件、加密恢复材料及离机备份。初始密码未写入仓库、界面源码或验证日志。管理员尚未由开发人员绑定验证器；首次登录必须自行改密并完成 TOTP。服务器的实际用户数据只有初始管理员，真实验证使用独立临时数据库且已清理。

若隧道已断开，在 PowerShell 执行该私密目录中的 `启动内部版.ps1` 后访问上述地址。入口仅对这台电脑可用；当前没有开放手机局域网入口、VPN 或公网入口。

## 已完成的验证

| 验证 | 结果 |
| --- | --- |
| Windows Node 24.15.0 自动化 | 65/65 通过 |
| 阿里云 Linux Node 24.22.1 自动化 | 65/65 通过 |
| 本机与 Linux 构建 | 通过，前端版本 `62e3eb778420` |
| 模型合成验证 | 1 次聊天、1 次提取、2 次嵌入；提取完成并语义找回，未重复请求 |
| SQLite 在线备份 | 完整性与外键检查通过 |
| AES-256-GCM 恢复 | 服务器和复制到 Windows 后的独立恢复检查均通过 |
| 角色边界 | 私有库隔离、项目只读聊天、全局只读审计、即时撤权、项目管理员 MFA 均通过 |
| 持久任务 | 断线继续、重连同步、请求幂等、停止、重启中断/队列恢复均通过 |
| 浏览器 | 1280px 桌面、390px 手机布局、明暗主题、Markdown 标题/粗体/列表/表格、记忆创建、项目创建与成员添加、账号创建、审计入口均已检查 |

界面证据在仓库的忽略目录 `output/playwright/`：`internal-desktop.png`、`internal-mobile-chat.png`、`internal-mobile-memory.png`、`internal-mobile-dark.png`、`internal-private-login.png`。均为合成验收数据。手机检查使用桌面浏览器视口模拟，未声称已经完成实体 iPhone 键盘或 PWA 安装验证。

浏览器检查确认页面没有横向溢出，输入区字体为 16px，页面缩小时输入区仍处于视口内。Markdown 使用实际安全渲染模块；已修正条件节点产生的 `false`/`undefined` 可见文本。刷新后的页面没有 JavaScript 运行时错误；未登录的 `/api/auth/me` 返回 401 属于预期行为。

退出后检查：sessionStorage 为空，私密消息 DOM 已移除；localStorage 仅保留主题设置。Service Worker 缓存只含 HTML 外壳、JS/CSS、manifest 和图标，没有 API 响应或聊天内容。390×440 缩小视口时输入区底部位于 408px，未超出视口；这属于浏览器模拟，不能替代实体 iOS 键盘验证。

## 服务隔离与备份

- 内部进程：PM2 `ai-qisao-internal`，专用用户 `qisao-internal`，Node 24.22.1，单实例。代码、环境配置、SQLite 和备份均位于 `/opt/ai-qisao-internal` 下的独立目录。
- 原公网进程也通过 91/91 Node24 兼容测试并切换为 `qisao-public` 专用用户。业务源代码和原有模型配置保持原样，健康检查正常。两服务不能读取对方的环境文件或内部数据库。
- 服务器每日 03:15（随机延迟最多 5 分钟）运行一致性备份，本地保留 14 天。`qisao-internal-backup.timer` 已启用。
- 加密副本已下载到这台 Windows 电脑并通过解密恢复验证。Windows 任务 `Weizhiyu-Internal-Encrypted-Backup-Pull` 每日 03:35 及登录时拉取，补跑错过的计划，本机保留 14 天。
- 本机离机拉取依赖电脑开机并登录、网络及 SSH 环境变量可用；它不是全天在线的独立云备份。正式团队使用前应按组织需求补充持续在线的独立备份存储及告警。恢复密钥在本机使用当前 Windows 用户的 DPAPI 保护。

原公网应用的运行时回滚配置保存在服务器的 `/opt/ai-qisao-backups/public-runtime-20261027.gLcK5X`，未放入仓库。原证书续期定时器仍正常启用。

## 发布状态

内部功能和私有访问已就绪，正式域名发布按用户要求延期。HTTP 证书验证此前被阿里云的备案接入阻断页返回 403；没有绕过该阻断或对外开放内部数据。以后上线需要再次确认接入状态、申请域名证书，并将配置恢复为 production HTTPS 后复核。

本次代码未提交或推送 GitHub；新增实现位于 `internal/`，另附内部检查 CI 工作流。真实模型验证仅执行一次，后续自动化测试均使用模拟供应商。
