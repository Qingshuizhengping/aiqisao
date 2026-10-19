# -*- coding: utf-8 -*-
"""生成优化后的图片资源（头像多规格、App 图标、噪点纹理）。

用法：python build_assets.py <源头像.png> <输出目录>
"""
import sys
import os
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else r"C:/Users/weizhiyu/AppData/Local/Temp/live_base/avatar.png"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "public", "static", "img")
os.makedirs(OUT, exist_ok=True)

im = Image.open(SRC).convert("RGBA")
W, H = im.size

# 原图是 1505x1506 的全身构图，头像位只需要"头部特写"。
# 取 42% 见方的区域、把面部放在圆心，等效于原来 CSS 里
# width:220% / left:-60% / top:0 的硬裁切，但只保留真正用到的像素。
side = int(min(W, H) * 0.42)
left = 491 * W // 1505
top = 30 * H // 1506
im = im.crop((left, top, left + side, top + side))


def emit(img, name, **kw):
    path = os.path.join(OUT, name)
    img.save(path, **kw)
    print(f"{os.path.getsize(path):>7} B  {name}")


def webp(size, quality, name):
    r = im.resize((size, size), Image.LANCZOS)
    emit(r, name, format="WEBP", quality=quality, method=6, exact=True)


def png(size, name, quantize=False):
    r = im.resize((size, size), Image.LANCZOS)
    if quantize:
        # PNG 没有质量参数，用调色板量化换来 3~5 倍体积下降，图标尺寸下肉眼看不出
        r = r.convert("RGB").quantize(colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG)
    emit(r, name, format="PNG", optimize=True)


# 列表/消息头像 32px -> 96 覆盖 3x
webp(96, 82, "avatar-96.webp")
# 品牌位 38px + 欢迎位 64px -> 192 覆盖 3x
webp(192, 84, "avatar-192.webp")
# 不支持 WebP 的极老环境兜底
png(192, "avatar-192.png", quantize=True)

# PWA 图标
png(512, "icon-512.png", quantize=True)
png(192, "icon-192.png", quantize=True)
png(180, "apple-touch-icon.png", quantize=True)
