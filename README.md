# 薇之雨 · AI七嫂（Vercel 部署版）

智能问答 Web 应用，前端静态页面 + Vercel Serverless Functions 代理硅基流动 AI 接口。API Key 通过环境变量注入，不暴露在前端。

## 项目结构

```
vercel-deploy/
├── index.html              # 主页面（头像已 base64 内联）
├── static/
│   ├── css/style.css       # 样式
│   └── js/app.js           # 前端逻辑（同源调用 /api/）
├── api/
│   ├── _config.js          # 共享配置（模型/System Prompt/工具函数，不作为路由）
│   ├── query.js            # 非流式问答接口（降级路径）
│   └── query_stream.js     # 流式问答接口（SSE，主路径）
├── vercel.json             # Vercel 函数配置
└── package.json
```

## 部署到 Vercel（一次配置，长期自动部署）

### 前置条件
- GitHub 账号（本仓库已推送）
- Vercel 账号（用 GitHub 登录）：https://vercel.com
- 硅基流动 API Key：https://cloud.siliconflow.cn → API 密钥

### 步骤

1. **登录 Vercel**：打开 https://vercel.com/new ，用 GitHub 登录。

2. **导入仓库**：在 "Import Git Repository" 列表中找到本仓库（`ai-qisao-vercel`），点 **Import**。
   - 若列表中没有，点 "Adjust GitHub App Permissions" 授权 Vercel 访问该仓库后刷新。

3. **配置项目**（Import 页面）：
   - Framework Preset：**Other**（保持默认）
   - Root Directory：保持默认（仓库根目录）
   - Build Command：留空（无需构建）
   - Output Directory：留空

4. **添加环境变量**（关键步骤）：展开 **Environment Variables**，添加一条：
   - Key：`SILICONFLOW_API_KEY`
   - Value：你的硅基流动 API Key（`sk-...`）
   - Environments：勾选 Production / Preview / Development 全部

5. **Deploy**：点 **Deploy** 按钮，等待约 1-2 分钟。

6. **获取公网地址**：部署完成后，Vercel 会给出一个 `https://ai-qisao-vercel-xxx.vercel.app` 形式的公网 URL，点击即可访问。

7. **（可选）绑定自定义域名**：项目 Settings → Domains，添加你自己的域名。

### 后续更新
代码 push 到 GitHub 仓库后，Vercel 会**自动重新部署**。无需任何手动操作。

## 本地开发（可选）

```bash
npm i -g vercel
vercel            # 首次登录并关联项目
vercel dev         # 本地启动（需先 vercel env add SILICONFLOW_API_KEY）
```

## 安全说明
- API Key 存放在 Vercel 环境变量，**前端代码中不含 Key**，公网访问不会泄露。
- 修改 Key：Vercel 项目 Settings → Environment Variables，改完重新部署即生效。
- AI 模型：`deepseek-ai/DeepSeek-V4-Flash`（硅基流动），可在 `api/_config.js` 中修改。
