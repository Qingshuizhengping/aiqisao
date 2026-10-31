# 员工助手核心模块

本版本保留原生 JavaScript、Express、SQLite WAL 和单实例部署。HTTP 路径、JSON 返回结构及账号数据保持兼容，模块间通过显式传参协作。

## 权限与状态

`lib/access.js` 负责实时有效账号、项目成员与归档状态、最后有效管理员保护和安全审计。系统控制面板与项目管理共用业务约束，入口仍各自检查系统角色、项目角色及会话。记忆和资料分别决定可见、编辑、审核与删除能力。

系统审计可以查看的资料不会自动进入管理员的日常聊天检索。异步检索、提取和索引在等待供应商后再次检查当前权限、资源版本、归档或删除状态。

## 聊天后端

`lib/chat.js` 是服务装配入口，继续提供 `createChatService({db,config,provider,memory,knowledge})`。

- `chat-routes.js`：HTTP 路由、SSE 传输与每次发送的会话验证。
- `chat-service.js`：会话读写、访问边界、上下文组装、幂等提交和限流。
- `chat-runner.js`：持久队列、生成执行、增量保存、停止、启动恢复和订阅生命周期。

回答分两条互斥的路径，由**唯一**配置 `config.groundingMode` 决定（`INTERNAL_GROUNDING_MODE`，默认 `free`）：

- `free`（默认）：`buildContext()` 组装上下文后走 `provider.chat()` 流式回答。检索为空不阻断回答。
- `strict`：检索、草稿、核验、发布四阶段，核验前只保存进度。严格依据服务、来源确认与标准事实规则见 [GROUNDING.md](GROUNDING.md)。

判定只看这一个字段，**不看是否注入了 provider**——早期版本用「调用方注入了模拟 provider 就自动降级」的隐式规则，导致测试可能静默走错分支，该规则已删除。`/api/health` 的 `grounding.mode` 输出真实值。

关闭 SSE 或离开页面只结束观察；服务端生成继续运行。明确停止通过现有停止 API 执行。重启恢复保留排队任务，将已开始但未结束的任务标为中断，避免重复请求模型。

## 存储失败熔断

`lib/storage-breaker.js` 是无数据库依赖的纯状态机（`closed` / `open` / `half-open`）：连续失败 5 次打开，冷却（默认 3 秒，重开翻倍、上限 60 秒）后转半开，调度器的「读取排队任务」查询本身充当探测，任一次成功即复位。

`chat-runner.js` 用它的 `allow()` 取代了原来那个「失败一次就永久 503」的布尔标记；`/api/health` 的 `chat.breaker` 暴露 `state / failures / openUntil / lastError`，`POST /api/chat/runs` 在熔断期返回 503 + `Retry-After`。**恢复不需要重启进程**。

## 搜索适配层与依据摘要

- `lib/search.js`：唯一可能访问公网的地方。未配置 provider/key、成员自己关闭、query 为空三种情况都直接返回 `disabled` 且**不产生任何 fetch**；`stub` 仅供测试，`tavily` 是骨架（配置后只降级、不外发）；超时与异常一律 `degraded`，回答照常。返回结果经 `sanitizeResults()` 清洗（只留 https、去凭据、截断长度、限量）。
- `shared/evidence-summary.js`：纯函数，把消息的 `metadata.files / memories / search` 收敛成 `{total, label, items, network, degraded}`，供前端角标渲染与测试直接 import。检索为空时不产生负向措辞，只让角标消失。
- `src/chat.js` 的角标是**新增**的一行（仅非审计视图），原有的 audit 分支一行未动；`visibleMessage()` 对非本人的消息额外把 `metadata.search` 清空（网络来源不跨账号共享）。

## 项目共享

`projects.shared` 是**资格标记**，不是可见性规则：所有读取路径仍然只查 `project_members`，被标记共享但未加入的项目对任何人都不可见。系统管理员在 `lib/admin.js` 的 `syncSharedProjects()` 里做全量对账（授予幂等、角色固定 `member`、从不降级或删除项目管理员、撤销仍走 `assertProjectAdminRemovable`），前端入口在 `src/shared-projects.js` 与 `src/control-panel.js`。

## 素材生成

`lib/images.js` 是装配入口 `createImageService({db, config, fetchImpl})`，返回 `{router, start, stop, health}`，由四块组成：

- `image-sizes.js`：六档尺寸白名单与面积上限（服务端唯一真源，前端只能传 key）。
- `image-store.js`：`image_jobs` 表**懒建**（与 `grounding-store.js` 同风格，不进 `database.js`），负责幂等键、认领、终态写入与重启态修复。
- `image-upstream.js`：混元请求、六级失败分级、COS 白名单下载、magic-bytes 嗅探、维度解析与落盘（`0700/0600`，写在数据目录下、绝不写 `dist/`）。
- `image-runner.js`：`imageConcurrency` 个工作协程，靠 `claimNext()` 的原子事务抢占任务；关闭时中止在飞任务并等待终态落库。
- `image-policy.js`：内存计数（每账号 5/分钟、30/小时，全局排队上限），重启清零是 PRD 允许的行为。

异步状态存在 SQLite 而不是内存，所以关闭面板、刷新页面、重启进程都能找回任务；`GET /api/images/jobs/:id/content` 是唯一的读图入口（同源，满足 `img-src 'self'`），并在 handler 内后设长缓存头覆盖 `/api/` 的 `no-store`。

## 浏览器工作区

`src/workspace-controller.js` 负责选择项目、选择会话、发送、停止和观察生成结果。页面负责布局，聊天组件负责渲染和草稿。

异步操作捕获固定的账号、项目、会话和视图上下文。会话列表按项目范围更新，消息按当前选择更新；旧操作不能覆盖新视图。草稿按原键及修改版本确认清除。控制面板的账号列表和账号编辑器分别维护生命周期，复用生命周期工具。

## 资料库

`lib/knowledge.js` 保留原服务接口和 HTTP 路由，按职责装配：

- `knowledge-access.js`：资料范围、能力与任务授权。
- `knowledge-store.js`：现有表初始化、字段投影和安全错误信息。
- `knowledge-parser.js` 与工作线程：受资源限制的本地解析和分段。
- `knowledge-jobs.js`：持久解析和语义索引任务。
- `knowledge-retrieval.js`：限定范围后的关键词、语义检索及返回前再验证。

已批准的有效共享资料归项目使用，保留原上传者及审计来源；上传者停用或退出不取消项目使用权。私人资料及待审核候选继续要求原作者有效。归档阻止后台写入，删除和版本变更阻止旧任务提交结果。

记忆仍保留独立的提取证据、冲突审核和索引规则；文件解析与记忆提取不共用状态机。

## 验证与发布

控制器测试注入 API、视图和观察器，通过挂起请求验证时序。服务测试使用内存或临时 SQLite 与模拟供应商。发布沿用版本化只读目录、发布前一致性备份和旧代码回滚；不会用旧快照覆盖上线后的新业务数据。
