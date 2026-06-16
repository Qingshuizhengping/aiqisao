# 薇之雨 · AI七嫂 — Android APK 构建指南

## 📱 项目概述

将「薇之雨 · AI七嫂」智能问答 Web 应用封装为独立 APK，支持：
- ✅ **离线打开** — 无网络时显示完整主界面（头像、欢迎语、快捷按钮），不显示 404
- ✅ **在线问答** — 联网时通过 API 与 AI 七嫂实时对话
- ✅ **优雅降级** — 网络断开时自动检测并提示用户，API 失败时显示友好错误
- ✅ **对话持久化** — 历史对话保存在本地 localStorage

## 📁 项目结构

```
yuren_apk/
├── www/                          # Web 资源（离线版）
│   ├── index.html                # 主页面（CSS/JS/头像全部内联）
│   └── avatar.png                # 头像图片
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
cd yuren_apk

# 2. 同步 web 资源到 Android 项目
npx cap sync android

# 3. 用 Android Studio 打开
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

### 修改后端 API 地址

编辑 `www/index.html`，找到：
```javascript
const API_BASE = 'https://web-production-b0601.up.railway.app';
```
替换为新地址后重新运行 `npx cap sync android`。

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
