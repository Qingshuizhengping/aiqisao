"""直接用图片1.png作为图标和启动页，不做任何修改"""
import os
from PIL import Image

SIZES = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192,
}

SPLASH_SIZES = {
    'drawable-port-mdpi': (480, 800),
    'drawable-port-hdpi': (720, 1280),
    'drawable-port-xhdpi': (1080, 1920),
    'drawable-port-xxhdpi': (1440, 2560),
    'drawable-port-xxxhdpi': (1920, 3200),
    'drawable-land-mdpi': (800, 480),
    'drawable-land-hdpi': (1280, 720),
    'drawable-land-xhdpi': (1920, 1080),
    'drawable-land-xxhdpi': (2560, 1440),
    'drawable-land-xxxhdpi': (3200, 1920),
}

BASE = r'h:\新建文件夹\设计文件\樊清正\个人\nvwa\6.16版ai七嫂\android\app\src\main\res'

# 读取本地图片
img = Image.open(r'h:\新建文件夹\设计文件\樊清正\个人\nvwa\6.16版ai七嫂\图片1.png')
if img.mode != 'RGBA':
    img = img.convert('RGBA')

# 图标：直接缩放，原样使用
for folder, size in SIZES.items():
    icon = img.resize((size, size), Image.LANCZOS)
    out_dir = os.path.join(BASE, folder)
    os.makedirs(out_dir, exist_ok=True)
    icon.save(os.path.join(out_dir, 'ic_launcher.png'), 'PNG')
    icon.save(os.path.join(out_dir, 'ic_launcher_round.png'), 'PNG')
    icon.save(os.path.join(out_dir, 'ic_launcher_foreground.png'), 'PNG')
    print(f'  {folder}: {size}x{size}')

# 启动页：白色背景 + 居中图片
for folder, (w, h) in SPLASH_SIZES.items():
    bg = Image.new('RGBA', (w, h), (255, 255, 255, 255))
    s = min(w, h) // 2
    resized = img.resize((s, s), Image.LANCZOS)
    bg.paste(resized, ((w - s) // 2, (h - s) // 2), resized)
    out_dir = os.path.join(BASE, folder)
    os.makedirs(out_dir, exist_ok=True)
    bg.save(os.path.join(out_dir, 'splash.png'), 'PNG')
    print(f'  {folder}: {w}x{h}')

# 通用 splash
bg = Image.new('RGBA', (1080, 1920), (255, 255, 255, 255))
s = 540
resized = img.resize((s, s), Image.LANCZOS)
bg.paste(resized, ((1080 - s) // 2, (1920 - s) // 2), resized)
bg.save(os.path.join(BASE, 'drawable', 'splash.png'), 'PNG')

print('\nDone!')
