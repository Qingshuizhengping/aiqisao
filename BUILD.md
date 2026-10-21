# 薇之雨 · AI七嫂 — Android APK 构建指南

## 📱 项目概述

将「薇之雨 · AI七嫂」智能问答 Web 应用封装为独立 APK，支持：
- ✅ **离线打开** — 无网络时显示完整主界面（头像、欢迎语、快捷按钮），不显示 404
- ✅ **在线问答** — 联网时通过 API 与 AI 七嫂实时对话
- ✅ **优雅降级** — 网络断开时自动检测并提示用户，API 失败时显示友好错误
- ✅ **对话持久化** — 历史对话保存在本地 localStorage

## 📁 项目结构

```
aiqisao/
├── web_app/
│   ├── index.html                # 网页版与离线版共用的页面结构
│   ├── static/css/style.css      # 共用样式
│   ├── static/js/app.js          # 网页版交互逻辑
│   └── offline.html.TEMPLATE     # 离线版网络检测与问答逻辑
├── build_offline_html.js          # 内联共用页面、样式与头像
├── www/                          # Web 资源（离线版）
│   └── index.html                # 生成文件，CSS/JS/头像全部内联
├── android/                      # Android 原生项目（Capacitor 生成）
│   └── app/src/main/
│       ├── AndroidManifest.xml   # 权限 & 网络安全配置
│       ├── java/.../MainActivity.java
│       └── res/
│           ├── values/strings.xml
│           └── xml/network_security_config.xml
├── capacitor.config.json         # Capacitor 配置
└── package.json
```

## 🛠 构建环境要求

### 必装软件

| 工具 | 版本要求 | 说明 |
|------|---------|------|
| **Android Studio** | Hedgehog (2023.1.1) 或更新 | IDE + SDK 管理 |
| **Android SDK** | API 34+ | compileSdk 36，最低支持 Android 7.0 (API 24) |
| **JDK** | 17 或 21 | Android Gradle Plugin 8.x 要求 JDK 17+ |
| **Node.js** | 18+ | Capacitor CLI 依赖 |

### 环境变量

```bash
# Windows (PowerShell)
$env:ANDROID_HOME = "C:\Users\你的用户名\AppData\Local\Android\Sdk"
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"

# macOS / Linux
export ANDROID_HOME=$HOME/Library/Android/sdk
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
```

## 📦 构建步骤

### 方式一：用 Android Studio 打开并构建（推荐）

```bash
# 1. 进入项目目录
cd aiqisao

# 2. 安装依赖并生成离线界面
npm install
npm run build

# 3. 同步 web 资源到 Android 项目
npx cap sync android

# 4. 用 Android Studio 打开
npx cap open android
```

Android Studio 打开后：
1. 等待 Gradle Sync 完成
2. 菜单栏：**Build → Build Bundle(s) / APK(s) → Build APK(s)**
3. APK 输出路径：`android/app/build/outputs/apk/debug/app-debug.apk`

### 方式二：命令行构建

```bash
# macOS / Linux
cd yuren_apk/android
./gradlew assembleDebug

# Windows
cd yuren_apk\android
gradlew.bat assembleDebug
```

## 🔧 离线机制说明

### 界面资源维护

页面结构修改 `web_app/index.html`，视觉样式修改 `web_app/static/css/style.css`。`npm run build` 自动把这两份共享资源与头像内联到 `www/index.html`，避免网页版和离线版外观分叉；无需手动维护第二份 HTML 或 CSS。

网页版交互逻辑在 `web_app/static/js/app.js`，离线版的网络检测和远程 API 降级逻辑保留在 `web_app/offline.html.TEMPLATE`。修改交互时应同时验证两种模式。

按钮的 Liquid Glass 是网页渐进增强，并非原生 iOS / SwiftUI 材质复刻：基础采用清透 CSS，Chromium 额外启用 SVG 背景折射，Safari 保留清透 CSS 回退，并尊重减少透明度、增强对比度与减少动态效果偏好。布局保留安全区内边距，使用 `dvh` 与移动端 `visualViewport` 高度补偿适配软键盘和横屏。

注意：若 `capacitor.config.json` 配置了 `server.url`，原生应用优先加载该远程网址。验证内置离线界面时应使用不含 `server.url` 的本地资源配置，或直接打开构建后的 `www/index.html`。

### 离线时行为

1. **主界面始终可用** — 所有 CSS/JS/头像图片都内联在 `index.html` 中（base64 data URI），不依赖任何外部资源
2. **离线检测** — JS 每 15 秒 ping 后端 + 监听 `navigator.onLine` 事件
3. **离线横幅** — 顶部显示橙色提示条「当前处于离线状态，智能问答功能暂不可用」
4. **降级回答** — 用户发送消息时，若断网则显示友好提示而非卡死

### 在线时行为

1. 检测到网络恢复 → 自动隐藏离线横幅
2. 消息通过流式 SSE (`/api/query_stream`) 获取，失败时降级到普通 JSON (`/api/query`)
3. 对话历史保存在 localStorage，App 重启后仍在

## 🔒 签名与发布

### Debug APK（开发测试）
直接 `assembleDebug` 生成，使用默认 debug 签名，可直接安装测试。

### Release APK（正式发布）
需要在 Android Studio 中配置签名密钥：
1. **Build → Generate Signed Bundle / APK**
2. 创建或选择 keystore
3. 选择 release 构建类型

## ⚙️ 自定义配置

### 当前部署

公网入口为 `https://8.134.141.217/`。服务器通过 PM2 管理 Node.js 服务，进程名为 `ai-qisao`，工作目录为 `/opt/ai-qisao`；前端文件位于该目录的 `public/`。本次更新保留服务器原有后端实现、接口协议与凭据，线上模型按用户要求切换为 `zai-org/GLM-5.3-Flash`。模型设置位于服务器的 `api/_config.js`，不由前端控制；`/api/health` 可检查当前模型，`/api/query_stream` 已完成一次真实流式问答验证。

HTTPS 使用受信任的 IP 证书，由独立环境中的 Certbot 5.8 管理：客户端为 `/opt/aiqisao-certbot/bin/certbot`，配置目录为 `/etc/letsencrypt-aiqisao`。IP 证书有效期约 160 小时，必须保持自动续期；定时器为 `aiqisao-certbot-renew.timer`，部署钩子 `/etc/letsencrypt-aiqisao/renewal-hooks/deploy/reload-nginx.sh` 在续期后重新加载 Nginx。已验证模拟续期及重载钩子；仍应持续检查续期定时器和证书有效期，不能依赖首次签发长期运行。

SSH 连接使用部署机器上的 `AIQISAO_SSH_HOST`、`AIQISAO_SSH_USER`、`AIQISAO_SSH_PASSWORD` 环境变量，凭据值不写入仓库、构建产物或日志。Android 继续使用系统 CA 信任与 HTTPS 限制，不为证书错误关闭校验。

生产网页与远程 App 入口使用同源 API。内置离线页面只读历史，联网按钮返回 HTTPS 在线版；素材入口也明确跳转 HTTPS，不开放通配或 `null` Origin 跨域。不要通过关闭 TLS 校验或开放 `file:` API 跨域来绕过错误。

新增 `/image` 素材入口由 `/api/image` 提供服务；`/api/health` 的 `imageReady` 只表示服务端是否配置密钥，不代表额度或真实生成已验证。`HUNYUAN_API_KEY`（或 `TOKENHUB_API_KEY`）仅放服务器环境或私有 `.env`，不要写入前端、仓库、日志。未配置时页面明确提示未启用，不调用收费接口。生成记录在本机；每次生成后，服务器按 24 小时时效和 160 张数量规则清理图片，请及时下载。

素材生成支持最多 20 张参考图，可多选、分批追加、逐张移除或清空。参考图只在当前页面内存中保存，按预览编号顺序提交 `referenceImages`；服务端保留旧 `referenceImage` 单图兼容。单张源文件限制 20MB，浏览器会压缩，所有参考图数据合计限制 14,000,000 字符，超限在调用模型前拒绝；HTTP 生图请求仍为 16MB，不影响聊天 1MB 限制。

尺寸保留五种固定 2K 档和默认 `1:1`，新增 `auto` 自动尺寸。自动模式不向上游传 `size` 或 `generate_max_pixels`，由模型按描述确定尺寸、使用默认档位（官方当前为 1.5K）；只传面积参数会默认方图，因此不把它作为“自动比例”。协议依据：[腾讯 Hy 生图调用指南](https://cloud.tencent.com/document/product/1823/135745)。

部署保留 `/opt/ai-qisao/api/_config.js`、`.env`、TLS 和既有生成图/下载，不把仓库默认聊天模型覆盖到生产。生图与提示词模块独立位于 `api/_env.js`、`api/image_config.js`、`api/image_gen.js`、`api/image_prompt.js`。`.env` 在读取模型配置前加载，已有进程环境变量优先。Nginx 的 `/api/image` 需允许 `client_max_body_size 16m` 和至少 240 秒代理读超时；聊天接口仍保持 1MB 请求体限制。

### 智能提示词优化

新版素材页采用两阶段请求，正常情况下用户仍只点一次生成：

1. `POST /api/image/prepare` 提交原文、尺寸、按顺序排列的参考图 SHA256 和请求 UUID。此接口仅接收小体积元数据（64KB），不上传参考图原文件，不额外发送用户照片给文字模型。
2. 优化器使用独立的视觉创作指令，不能复用七嫂问答角色。目标是在保留主体、品牌和准确文案的前提下，改善构图、色彩、光线、材质、视觉层次和留白，而不是单纯扩写文字。服务端检查结构、长度和关键内容；准备成功返回短期生成票据，关键歧义返回澄清问题，内容安全拒绝停止流程。
3. 素材页自动向原 `POST /api/image` 提交原输入、完整参考图及票据。服务端校验票据、尺寸和图片顺序哈希后使用认可的优化词生成，保留原来的 COS 安全下载和图片清理逻辑。

服务端新安装默认关闭，仅在私有环境中设置 `PROMPT_OPTIMIZER_ENABLED=true` 后重启 `ai-qisao`。素材页在服务就绪后默认开启视觉优化，用户点击生成即先优化、再自动衔接生图，仍可手动关闭优化。当前优化模型使用 `zai-org/GLM-5.3-Flash`，通过 `PROMPT_OPTIMIZER_MODEL` 独立指定，不改聊天模型。密钥、地址和模型可通过 `.env.example` 中的 `PROMPT_OPTIMIZER_*` 单独配置，不填写时复用当前服务端聊天配置，但不使用聊天角色或聊天历史。`promptOptimizationReady` 仅表示开关和必要配置齐备，不代表优化模型额度、可用性或效果已被真实调用验证。

优化默认最多等待 20 秒，环境变量 `PROMPT_OPTIMIZER_TIMEOUT_MS=20000`，服务端硬上限也为 20 秒。前端优化请求留出 30 秒网络预算，与后续生图的 240 秒等待分开；页面只显示优化与生成状态，不显示计时、已用秒数或倒计时。视觉建议精简为 80–200 字、最多 400 字，正文输出预算 600 tokens；这不保证模型一定在 20 秒内完成，也不代表限制了模型内部思考 token。技术失败只能由用户点击“使用原词继续”，不静默降级；安全拒绝不提供绕过。页面展示原文、优化词与生图模型自行改写的来源，不自动替换输入框；历史记录的新字段可选，旧记录继续可读，参考图和生成票据不写入本地历史。

优化额外消耗一次文字模型调用。每 IP 优化请求限制为每分钟 5 次、每小时 30 次，优化全局最多 2 个并发、每小时 120 次上游调用。相同 UUID 与输入复用已有处理结果，冲突输入拒绝；生成票据与输入、来源、有效期及进程启动周期绑定，票据本身不代替去重。内存记录有容量和时效限制，重启后旧票据失效，不承诺跨重启或上游状态不明时的严格一次计费。已提交的生图请求断网、取消等待或超时均不表示上游停止计费，不自动重新生图。

发布时必须同步包含新增的 `api/image_prompt.js`，并更新部署白名单、备份和回滚清单。先以关闭状态发布并做模拟回归，再启用开关。原文件、gzip 和 Brotli 解压内容必须一致；缺少 Brotli 依赖时构建会移除旧 `.br`，避免新页面加载旧脚本。真实优化/生图对照验证需另行确认费用，模拟测试不能作为模型效果改善的证据。

### 素材生成（生图）独立入口

优化版 `optimized/` 新增独立页面 `/image`，入口在对话页侧边栏「素材生成」，不占用对话流。

- 后端：`POST /api/image`（`optimized/server.js` → `optimized/api/image_gen.js`）
- 模型：`hy-image-v3.5-preview`；默认 2K（2048×2048），服务端硬性封顶 2048×2048，**不开放 4K**
- 密钥：只读服务端环境变量 `HUNYUAN_API_KEY`（`optimized/.env` 或 PM2 环境注入），前端永不接触
- 上游返回的是 12 小时有效的鉴权临时地址，服务端下载后转存到 `public/static/gen/`，前端只引用本站地址；该目录按「160 张 / 24 小时」自动清理，且不入版本库
- 防刷：每 IP 每分钟 5 次、每小时 30 次（内存计数）
- 构建：`cd optimized && python build.py`（需 Pillow、brotli、npx esbuild）；启动：`npm start`
- 发版务必修改 `optimized/public/sw.js` 的 `VERSION`，否则老用户会拿旧缓存

### 修改后端 API 地址

编辑 `web_app/offline.html.TEMPLATE`，找到：
```javascript
const API_BASE = 'https://8.134.141.217';
```
替换为验证过 HTTPS 的新地址后，运行 `npm run build` 重新生成 `www/index.html`，再运行 `npx cap sync android`。若应用首屏也迁移，应同步更新 `capacitor.config.json` 的 `server.url` 和 `allowNavigation`，以及 iOS 安装入口。

### 修改 App 名称

编辑 `android/app/src/main/res/values/strings.xml`：
```xml
<string name="app_name">薇之雨·AI七嫂</string>
```

### 修改包名

1. 编辑 `capacitor.config.json` 中的 `appId`
2. 删除 `android/` 目录
3. 重新运行 `npx cap add android`

## 🐛 常见问题

### Q: 构建报错 "SDK location not found"
创建 `android/local.properties` 文件：
```
sdk.dir=C\:\\Users\\你的用户名\\AppData\\Local\\Android\\Sdk
```

### Q: Gradle sync 失败
检查 JDK 版本（需要 17+）和网络（Gradle 需要下载依赖）

### Q: APK 安装后打开白屏
确认 `npx cap sync android` 已执行，把 `www/` 目录下的资源复制到了 Android 项目

### Q: 头像不显示
头像已内联为 base64 data URI，不依赖外部文件，不应出现此问题。如有问题检查 WebView 版本。
