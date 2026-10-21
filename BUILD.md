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

部署保留 `/opt/ai-qisao/api/_config.js`、`.env`、TLS 和既有生成图/下载，不把仓库默认聊天模型覆盖到生产。新生图模块独立位于 `api/_env.js`、`api/image_config.js`、`api/image_gen.js`。`.env` 在读取生图模型配置前加载，已有进程环境变量优先。Nginx 的 `/api/image` 需允许 `client_max_body_size 16m` 和至少 240 秒代理读超时；聊天接口仍保持 1MB 请求体限制。

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
