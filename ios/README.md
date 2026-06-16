# iOS 安装指南

## 方式一：Safari 添加到主屏幕（推荐）

这是最简单的方式，无需安装描述文件。

### 步骤：

1. **使用 Safari 打开网站**
   - 在 iPhone/iPad 上打开 Safari 浏览器
   - 访问：`https://web-production-b0601.up.railway.app/`

2. **添加到主屏幕**
   - 点击底部的「分享」按钮（方框带向上箭头的图标）
   - 向下滚动，点击「添加到主屏幕」
   - 输入名称：`AI七嫂`（或保持默认）
   - 点击右上角「添加」

3. **完成**
   - 主屏幕会出现「AI七嫂」图标
   - 点击图标即可全屏打开应用
   - 体验接近原生 App

---

## 方式二：安装描述文件（企业部署）

使用 `.mobileconfig` 描述文件可以批量部署到多台设备。

### 步骤：

1. **传输描述文件到 iOS 设备**
   - 将 `AI七嫂.mobileconfig` 文件通过以下方式之一传输到设备：
     - AirDrop
     - 邮件发送
     - 上传到 iCloud Drive / 其他云存储
     - 通过 MDM（移动设备管理）系统推送

2. **安装描述文件**
   - 在 iOS 设备上打开描述文件
   - 系统会提示「已下载描述文件」
   - 进入「设置」>「已下载描述文件」
   - 点击「安装」，输入设备密码确认

3. **完成**
   - 主屏幕会自动出现「AI七嫂」图标
   - 点击即可打开 Web 应用

### 注意事项：

- 描述文件需要签名才能在生产环境使用
- 未签名的描述文件只能用于测试
- 企业部署建议通过 MDM 系统推送

---

## 方式三：使用 Xcode 构建原生 App

如果需要发布到 App Store，需要使用 Capacitor 或类似框架。

### 环境要求：

- macOS 系统
- Xcode 14+
- Node.js 18+
- CocoaPods

### 构建步骤：

```bash
# 1. 进入项目目录
cd 6.16版ai七嫂

# 2. 安装依赖
npm install

# 3. 添加 iOS 平台（如果还没有）
npx cap add ios

# 4. 同步 Web 资源
npx cap sync ios

# 5. 用 Xcode 打开
npx cap open ios
```

在 Xcode 中：
1. 配置签名（Signing & Capabilities）
2. 选择设备或模拟器
3. 点击运行按钮构建并安装

---

## 图标说明

当前使用的图标来自：`https://aka.doubaocdn.com/s/vQH41wbtOO`

如需自定义图标：
1. 准备 1024x1024 的 PNG 图片
2. 替换 `web_app/avatar.png`
3. 重新运行 `node build_offline_html.js` 生成内联图标
4. 更新 `manifest.json` 中的图标路径

---

## 对比两种安装方式

| 特性 | Safari 添加 | 描述文件 |
|------|------------|---------|
| 难度 | ⭐ 简单 | ⭐⭐⭐ 复杂 |
| 适用场景 | 个人使用 | 企业批量部署 |
| 需要电脑 | 否 | 是（传输文件） |
| 自动更新 | 是 | 是 |
| 离线支持 | 否 | 否 |
| 推送通知 | 否 | 否 |
| 主屏幕图标 | 是 | 是 |

---

## 常见问题

### Q: 添加到主屏幕后，打开是 Safari 而不是全屏？
A: 确保网站包含 `<meta name="apple-mobile-web-app-capable" content="yes">` 标签。当前网站已包含此标签。

### Q: 图标不显示或显示默认图标？
A: iOS 对 Web App 图标有缓存，尝试清除 Safari 缓存后重新添加。

### Q: 描述文件安装失败？
A: 检查描述文件是否完整，UUID 是否唯一。生产环境需要 Apple 签名。

### Q: 应用内无法使用摄像头/麦克风？
A: iOS Safari 对 Web App 的硬件访问有限制，部分功能可能无法使用。
