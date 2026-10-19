# -*- coding: utf-8 -*-
"""构建 AI 七嫂优化版静态产物。

做四件事：
  1. 生成图片资源（调用 build_assets.py）
  2. 用 esbuild 压缩 JS / CSS
  3. 把 CSS 内联进 index.html（首屏 0 个阻塞请求）
  4. 预压缩 .br / .gz，服务端直出

用法：python build.py
依赖：node（npx esbuild）、pillow（可选，已存在图片可跳过）
"""
import gzip
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
PUBLIC = os.path.join(ROOT, "public")

try:
    import brotli
except ImportError:
    brotli = None


def run(cmd, **kw):
    result = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw)
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        raise SystemExit("命令失败: " + (cmd if isinstance(cmd, str) else " ".join(cmd)))
    return result.stdout


def minify(src, out, loader):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    # Windows 下 npx 是 .cmd，必须交给 shell 执行
    cmd = f'npx --yes esbuild "{src}" --minify --target=es2019 --outfile="{out}"'
    run(cmd)
    return out


def precompress(path):
    raw = open(path, "rb").read()
    with gzip.open(path + ".gz", "wb", compresslevel=9) as f:
        f.write(raw)
    if brotli:
        with open(path + ".br", "wb") as f:
            f.write(brotli.compress(raw, quality=11, lgwin=22))


def human(n):
    return f"{n / 1024:.1f} KB" if n >= 1024 else f"{n} B"


def main():
    # 1. 图片
    avatar = os.path.join(ROOT, "..", "deploy", "avatar.png")
    if os.path.exists(avatar):
        run([sys.executable, os.path.join(ROOT, "build_assets.py"), avatar,
             os.path.join(PUBLIC, "static", "img")])
    else:
        print("跳过图片生成（找不到 deploy/avatar.png，沿用 public/static/img 现有文件）")

    # 2. 压缩
    app_js = minify(os.path.join(SRC, "app.js"), os.path.join(PUBLIC, "static", "js", "app.js"), "js")
    field_js = minify(os.path.join(SRC, "lightfield.js"), os.path.join(PUBLIC, "static", "js", "lightfield.js"), "js")
    css_out = minify(os.path.join(SRC, "styles.css"), os.path.join(ROOT, "build", "styles.min.css"), "css")
    css = open(css_out, encoding="utf-8").read()

    # 3. 内联
    html = open(os.path.join(SRC, "index.html"), encoding="utf-8").read()
    if "/*__STYLES__*/" not in html:
        raise SystemExit("index.html 里找不到 /*__STYLES__*/ 占位符")
    html = html.replace("/*__STYLES__*/", css)
    index_path = os.path.join(PUBLIC, "index.html")
    open(index_path, "w", encoding="utf-8", newline="\n").write(html)

    # 4. 预压缩（只压会走网络的文本资源）
    for path in [index_path, app_js, field_js,
                 os.path.join(PUBLIC, "sw.js"),
                 os.path.join(PUBLIC, "manifest.json")]:
        precompress(path)

    # 5. 报告
    print("\n产物体积")
    print("-" * 52)
    total_raw = total_gz = total_br = 0
    for path in [index_path, app_js, field_js]:
        raw = os.path.getsize(path)
        gz = os.path.getsize(path + ".gz")
        br = os.path.getsize(path + ".br") if brotli else 0
        total_raw += raw
        total_gz += gz
        total_br += br
        print(f"{os.path.relpath(path, PUBLIC):<28}{human(raw):>10}{human(gz):>10}{human(br):>10}")
    print("-" * 52)
    print(f"{'文本合计':<26}{human(total_raw):>10}{human(total_gz):>10}{human(total_br):>10}")

    img_dir = os.path.join(PUBLIC, "static", "img")
    img_total = sum(os.path.getsize(os.path.join(img_dir, f)) for f in os.listdir(img_dir)
                    if not f.endswith((".gz", ".br")))
    print(f"\n图片目录合计: {human(img_total)}")


if __name__ == "__main__":
    main()
