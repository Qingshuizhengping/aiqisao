import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

// (a) 源码目录必须完全脱离兄弟目录：任何指向兄弟参考实现的路径都会让 `internal/`
// 单独 clone 后无法构建。这条断言是 H2 的核心回归保护。
const SOURCE_DIRECTORIES = ['lib', 'src', 'scripts', 'shared', 'third_party'];
const SOURCE_FILES = ['server.js', 'launch.mjs', 'package.json'];
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.json', '.html', '.md', '.txt']);
// 兄弟目录名拆开拼装，避免本文件自身成为被禁止的字面量命中点。
const SIBLING = 'optimized';
const FORBIDDEN = new RegExp('\\.\\.\\/' + SIBLING + '|' + SIBLING + '\\/src');

function collectFiles(target, collected = []) {
    if (!fs.existsSync(target)) return collected;
    const stats = fs.statSync(target);
    if (stats.isFile()) { collected.push(target); return collected; }
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        collectFiles(path.join(target, entry.name), collected);
    }
    return collected;
}

function sourceFiles() {
    const files = [];
    for (const directory of SOURCE_DIRECTORIES) collectFiles(path.join(root, directory), files);
    for (const name of SOURCE_FILES) collectFiles(path.join(root, name), files);
    return files.filter(file => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

// (b) vendored 产物必须真实存在且是完整的上游 dist（约 42KB），避免「文件被清空但测试仍绿」。
test('sources never reference the sibling reference-project directory and the vendored bundle is complete', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
        const content = fs.readFileSync(file, 'utf8');
        if (FORBIDDEN.test(content)) offenders.push(path.relative(root, file));
    }
    assert.deepEqual(offenders, [], 'these files still reference the sibling project: ' + offenders.join(', '));
    const bundle = path.join(root, 'src/vendor/marked-18.0.9.mjs');
    assert.ok(fs.existsSync(bundle), 'vendored marked bundle is missing');
    assert.ok(fs.statSync(bundle).size >= 40000, 'vendored marked bundle looks truncated');
    const renderer = fs.readFileSync(path.join(root, 'src/vendor/markdown.js'), 'utf8');
    assert.match(renderer, /from '\.\/marked-18\.0\.9\.mjs'/, 'renderer must import the vendored copy relatively');
    assert.match(renderer, /export function renderMarkdown/, 'renderer keeps its only public export');
    // 站点样式快照同样内置，不能留在兄弟目录里。
    assert.ok(fs.existsSync(path.join(root, 'src/vendor/optimized-styles.css')));
    assert.match(fs.readFileSync(path.join(root, 'src/base.css'), 'utf8'), /@import url\('\.\/vendor\/optimized-styles\.css'\)/);
});

// (c) 版本必须如实声明且三处一致：package.json、third_party/README.md、vendored 文件名。
test('declared marked version matches the vendored fileName and third_party notes', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies.marked, '18.0.9');
    assert.ok(fs.existsSync(path.join(root, 'third_party/marked-18.0.9.LICENSE')));
    const notes = fs.readFileSync(path.join(root, 'third_party/README.md'), 'utf8');
    assert.match(notes, /18\.0\.9/, 'third_party/README.md must state the version');
    assert.match(notes, /src\/vendor\/marked-18\.0\.9\.mjs/);
    assert.ok(fs.existsSync(path.join(root, 'src/vendor/marked-18.0.9.mjs')));
    assert.equal('marked-' + manifest.dependencies.marked + '.mjs', 'marked-18.0.9.mjs');
});

// 只真正构建一次：构建约 1-2 秒，避免同一文件里重复付出代价。
let buildResult;
function runBuild() {
    if (buildResult) return buildResult;
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root, encoding: 'utf8' });
    buildResult = { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
    return buildResult;
}

// (d) 真实跑一次构建：产物齐全、HTML 引用带版本号。
test('npm run build produces the full dist output without leaving the repository', { timeout: 120000 }, () => {
    const result = runBuild();
    assert.equal(result.status, 0, 'build failed: ' + (result.stderr || result.stdout));
    const built = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(built.built, true);
    assert.match(built.version, /^[0-9a-f]{12}$/);
    for (const file of ['index.html', 'THIRD_PARTY_NOTICES.txt', 'sw.js', 'assets/app.js', 'assets/style.css']) {
        assert.ok(fs.existsSync(path.join(root, 'dist', file)), 'missing build output: ' + file);
    }
    const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
    assert.ok(html.includes('/assets/app.js?v=' + built.version), 'html must reference the versioned bundle');
    assert.ok(html.includes('/assets/style.css?v=' + built.version), 'html must reference the versioned stylesheet');
    const css = fs.readFileSync(path.join(root, 'dist/assets/style.css'), 'utf8');
    // 样式单包必须同时包含 base.css 与内置的站点样式快照（@import 解析失败时构建会直接报错）。
    assert.ok(css.length > 20000, 'bundled stylesheet must carry the vendored site styles');
    // 渲染包装必须真的被打进前端单包：`qisaoLooseStrong` 是 markdown.js 扩展名的字符串字面量，
    // 压缩后仍然保留（函数名会被压缩，所以不按 renderMarkdown 断言）。
    assert.match(fs.readFileSync(path.join(root, 'dist/assets/app.js'), 'utf8'), /qisaoLooseStrong/);
});

test('the bundled third-party notices reproduce the vendored marked license', { timeout: 120000 }, () => {
    assert.equal(runBuild().status, 0);
    const notices = path.join(root, 'dist/THIRD_PARTY_NOTICES.txt');
    assert.ok(fs.existsSync(notices), 'THIRD_PARTY_NOTICES.txt is missing');
    const content = fs.readFileSync(notices, 'utf8');
    assert.match(content, /marked/i);
    assert.equal(content, fs.readFileSync(path.join(root, 'third_party/marked-18.0.9.LICENSE'), 'utf8'));
});
