# AI 七嫂 · 优化版（性能 + 视觉）

在**不改动任何原有文件**的前提下，把线上 `https://8.134.141.217` 的前端重做了一份。
原版目录（`deploy/`、`vercel-deploy/`、`ali-deploy/`、`www/`、`web_app/`）保持原样，可直接回滚。

---

## 一、优化结果

测试条件：Chromium 无头浏览器，390×844 手机视口，Slow 4G（1.6Mbps / 150ms RTT）+ 4× CPU 降速，缓存全关，取 3 次中位数。

| 指标 | 原版 | 优化版 | 变化 |
|---|---|---|---|
| 首屏请求数 | 15 | **4** | −73% |
| 传输体积（未压缩） | 1,351 KB | **69.4 KB** | **−94.9%** |
| 传输体积（br 压缩后） | ~1,300 KB | **~26.8 KB** | **−97.9%** |
| FCP 首次内容绘制 | 1012 ms | **500 ms** | −50.6% |
| LCP 最大内容绘制 | 1132 ms | **804 ms** | −29.0% |
| DOMContentLoaded | 1084 ms | **743 ms** | −31.5% |
| Load 完成 | 6835 ms | **788 ms** | **−88.5%** |

体积构成：

| 资源 | 原版 | 优化版 | 说明 |
|---|---|---|---|
| 头像 | 1,288 KB (png) | **12.2 KB** (webp) | 1505² 整张图缩放到 192²，按圆心重新裁切 |
| 样式 | 27.9 KB 阻塞请求 | **0**（内联） | 塞进 HTML head，去掉一次关键路径往返 |
| JS | 27.3 KB / 3 个文件 | **13.1 KB / 1 个** | 合并 + 压缩，玻璃折射脚本按需加载 |
| 背景光场 | 无 | 3.8 KB（延后加载） | 原生 WebGL，见下文 |

---

## 二、性能做了什么

1. **头像治本**。原图 1505×1506、1.29 MB，实际显示只有 32 / 38 / 68 px 三个尺寸，却加载了整张原图——它一个文件就占了首屏 95% 的流量。现在按头部构图裁成正方形，输出 192px WebP（12.2 KB）和 96px WebP（4.8 KB），另留一份量化 PNG 兜底。CSS 里原来靠 `width:220%; left:-60%` 硬裁，现在图本身就是裁好的，省掉无效像素。

2. **消灭阻塞请求**。27.9 KB 的 `style.css` 内联进 `<head>`，首屏不再有 render-blocking 的 CSS；JS 改用 `defer`，不再挡解析。

3. **首帧前定主题**。`data-theme` 和 `--app-height` 由 `<head>` 里的一小段同步脚本先写死，避免深色模式下白屏闪一下、以及移动端地址栏导致的高度跳动（CLS）。

4. **WebGL 延后、降频**。光场画布在 `load` 之后用 `requestIdleCallback` 加载，0.65×DPR 低分辨率渲染、30fps、页面不可见即停帧。低端机完全不会因为背景动画掉帧。

5. **流式 Markdown 分段渲染**。已完成段落只解析一次，活动段落按 80ms 合并预览。浏览器与服务端使用同一份固定版本 Marked 安全渲染模块，原始 HTML 转义，链接协议受限。旧安装版仍能通过 `done.html` / 普通接口获得已排版答案。

6. **滚动不再打架**。原版每帧强制 `scrollTop`，用户往上翻会被拽回底部；现在只在"本来就在底部"时才跟随。

7. **历史对话批量插入**。用 `DocumentFragment` 一次性替换，长列表不再逐条 append；超过 24 条的对话才启用 `content-visibility`，短的保持精确布局。

8. **服务端缓存与预压缩**。`server.js` 直接吐 build 阶段生成的 `.br/.gz`，按类型下发 `Cache-Control`，支持 `If-Modified-Since` 返回 304。原版是 `max-age=0`，每次访问都要重新下载全部资源。

9. **Service Worker**。导航和未版本化主脚本优先联网，4 秒超时后回退缓存；版本化静态资源缓存优先，断网仍能查看界面和历史。接管 Service Worker 不等于替换正在执行的旧脚本，因此更新只提示、由用户主动确认，不会在输入或回答途中强制重载。

---

## 三、视觉做了什么

- **纯白底**：`#ffffff`。深浅两套主题都通过 CSS 变量切换，`:root` / `[data-theme="dark"]`。
- **玻璃质感**：不是单一 `backdrop-filter`，而是四层叠出来的：
  1. 冷白填充（`rgb(250 252 255)`，比纯白低半度——白底上玻璃能被看见的唯一办法就是这点色差）；
  2. 1px 发丝线：白底上白色描边等于没有，所以大面板用 `rgba(15,20,32,.075)` 的冷灰细线，深色下换成 `rgba(255,255,255,.15)`；
  3. 2px 折射环：`backdrop-filter: url(#glassLens)` 用 `feTurbulence` + `feDisplacementMap` 把边缘的背景做位移，只做"边缘一点点弯"，不承担描边职责（描边交给下面这条）；
  4. 跟随指针的液面光泽（`--mx/--my` 变量 + `requestAnimationFrame` 节流）。
- **深色模式**：跟随系统、手动可切、记忆在 `localStorage`；切换时 WebGL 光场用 0.45s 插值过渡，不硬跳。
- **背景光场**：原生 WebGL 单 pass 全屏着色器，画 4 个缓慢漂移的光池。浅色下只留 5.5% 着色（大面积仍是纯白，实测 249–251），给玻璃边缘一点可折射的东西；深色下才明显。
- **无障碍**：`prefers-reduced-motion` / `prefers-reduced-transparency` / `prefers-contrast` 全部有降级；保留了原版的焦点管理、`aria-live`、键盘 Tab 循环。

### 关于 Three.js

没有用。这里只需要"一层缓慢流动的柔光"，three.js 光核心就 150 KB+，比整个优化后的首屏还大。用原生 WebGL 写一个全屏三角，**3.8 KB** 就画完了。如果之后要做真正的 3D 折射场景（比如可交互的玻璃球），再引 three.js 也不迟——但那属于另一个量级的需求。

---

## 四、目录结构

```
optimized/
├── src/                    源码（改这里）
│   ├── index.html          页面骨架，CSS 用 /*__STYLES__*/ 占位
│   ├── styles.css          全部样式（浅色 + 深色 + 玻璃）
│   ├── app.js              业务逻辑
│   └── lightfield.js       WebGL 背景光场
├── public/                 构建产物，直接部署这个目录
│   ├── index.html          CSS 已内联
│   ├── sw.js
│   ├── manifest.json
│   └── static/{js,img}/
├── api/_config.js          复用原后端配置（system prompt / 模型）
├── server.js               阿里云部署用的服务端（预压缩 + 缓存）
├── nginx.conf              如果前面有 nginx，把它合并进去
├── build.py                构建脚本
├── build_assets.py         图片资源生成
├── report.html             前后对比报告（浏览器打开）
├── preview.html            界面预览（图片已内嵌，单文件可直接发给别人）
└── preview/                PNG 预览图（浅色/深色/移动端）
```

## 五、重新构建

```bash
cd optimized
python build.py          # 需要 node（调用 npx esbuild）
```

会重新生成图片、压缩 JS、内联 CSS、输出 `.br/.gz`，并打印体积表。

## 六、部署（阿里云，沿用现有方式）

```bash
# 1. 备份现有 public
ssh root@8.134.141.217 "cp -r /path/to/ali-deploy/public /path/to/ali-deploy/public.bak.$(date +%F)"

# 2. 传产物
scp -r optimized/public/* root@8.134.141.217:/path/to/ali-deploy/public/
scp optimized/server.js root@8.134.141.217:/path/to/ali-deploy/server.js

# 3. 重启
ssh root@8.134.141.217 "cd /path/to/ali-deploy && pm2 restart all"
```

`server.js` 只依赖 `express`（原项目已有），不需要额外装包；`api/_config.js` 不需要动。

**回滚**：把 `public.bak.*` 换回去，`pm2 restart` 即可。

**发版提醒**：改了前端后，把 `public/sw.js` 里的 `VERSION` 改一个值（如 `qisao-v2`），否则老用户可能还会读到缓存。

前端 `CLIENT_VERSION`、HTML 主脚本查询参数和 SW 版本需同步。服务端必须一起部署 `public/static/js/markdown.mjs`，并保留 `public/THIRD_PARTY_NOTICES.txt`；不要覆盖线上 `api/_config.js`、环境密钥或 TLS 配置。

旧会话会在回答末尾得到主动更新链接；点击前先保存未发送草稿，对话历史不会清除。新客户端的更新按钮会先保存草稿和当前会话，再加载新版。单纯发布网页不能替换已经安装 APK 的 Java 或内置 HTML。

根目录 `node build_offline_html.js` 现在从已构建的 `optimized/public` 内联生成 APK 离线页，无需先安装 npm 依赖。内置离线页只读历史，明确提示联网返回在线版，不开放 `file:` 来源的 API 跨域。原有 debug APK 的签名证书可能与新构建不同，未核实签名前不要要求用户卸载重装或覆盖安装。

## 七、还没做 / 需要注意

- 原版把 `SILICONFLOW_API_KEY` 写在前端（`deploy/static/js/app.js`）。这份优化版走的是 `/api/` 代理，Key 只在服务端，但**线上如果还在用直调版本，Key 是公开的，建议一并换掉**。
- 首屏字体用的是系统字体栈，没有外部字体请求；如果以后要换品牌字体，记得加 `font-display: swap` 并预加载。
- WebGL 光场在部分老安卓 WebView 上会回落到 CSS 渐变（观感差距很小），不影响功能。
