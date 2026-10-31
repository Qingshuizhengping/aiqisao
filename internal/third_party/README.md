# 第三方组件与许可

本目录保存**随仓库内置（vendored）**的第三方产物及其许可原文，目的是让 `internal/` 在没有网络、
没有兄弟目录的情况下也能独立 `npm ci && npm run build`。

## marked 18.0.9

| 项目 | 值 |
| --- | --- |
| 组件 | [Marked](https://marked.js.org/)（Markdown 解析器） |
| 版本 | `18.0.9` |
| 本仓库文件 | `third_party/marked-18.0.9.LICENSE`（MIT 许可原文）、`src/vendor/marked-18.0.9.mjs`（上游 ESM 产物原样副本） |
| 上游发布 | <https://registry.npmjs.org/marked/-/marked-18.0.9.tgz> |
| Archive integrity | `sha512-/Sa4qiiHZxf0/FQdBBowr9q4r10krCwMvpK48FUBdXdUXScDxiQGR9zCPrFgRVR5LU3iySOiIjy09ZQvADir1w==` |
| 原始模块 SHA-256 | `2c9b2113f8ef95ad21349952644fc1b3f759f0f92aff2ad4016a574b5ce19de5` |

`src/vendor/marked-18.0.9.mjs` 是官方 npm 包中 `lib/marked.esm.js` 的**未修改**副本；
`src/vendor/markdown.js` 是本站点自己的渲染包装（转义原始 HTML、只放行 http(s)/mailto 链接、
图片降级为文字、中文宽松加粗扩展），仅把 `import` 指向同目录的 vendored 产物。

版本一致性由 `tests/build.test.js` 机器校验：`package.json` 的 `dependencies.marked`、
本文件中的版本号、以及 `src/vendor/marked-18.0.9.mjs` 的文件名必须同为 `18.0.9`。

### 升级步骤

1. 下载并解包目标版本的 npm 发布物，取 `lib/marked.esm.js`；
2. 覆盖 `src/vendor/marked-18.0.9.mjs`（改名成新版本号，并同步 `src/vendor/markdown.js` 的 import 与下方 `index.html` 无关的引用）；
3. 覆盖本目录的 `marked-<版本>.LICENSE`（删除旧版本文件）；
4. 同步更新 `package.json` 的 `dependencies.marked` 与本文件的版本号/哈希；
5. 跑 `npm test`（含渲染行为用例）与 `npm run build`。

> 为什么不用 `import { Marked } from 'marked'`：vendored 产物是**已验证行为**的固定快照，
> 改成从 `node_modules` 解析会把渲染行为绑到 npm 解析结果上（且 `marked` 的 ESM 入口导出形状
> 与 dist 略有差异）。保留 vendor + 如实声明版本 = 不进构建风险，又能机器校验版本。

## 站点样式快照

`src/vendor/optimized-styles.css` 是内部版界面基线样式（玻璃质感主题）的快照，
为脱离兄弟目录构建而内置。它与 `src/base.css`、`src/studio.css` 一同被 `src/style.css` 引入，
不涉及第三方许可。
