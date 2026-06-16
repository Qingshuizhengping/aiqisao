"""直接用透明底头像作为 App 图标和启动页"""
import urllib.request, io, os
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

# 下载头像
url = 'https://aka.doubaocdn.com/s/vQH41wbtOO'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
data = urllib.request.urlopen(req).read()
avatar = Image.open(io.BytesIO(data))
if avatar.mode != 'RGBA':
    avatar = avatar.convert('RGBA')

# 图标：直接缩放，不加背景不加遮罩
for folder, size in SIZES.items():
    icon = avatar.resize((size, size), Image.LANCZOS)
    out_dir = os.path.join(BASE, folder)
    os.makedirs(out_dir, exist_ok=True)
    icon.save(os.path.join(out_dir, 'ic_launcher.png'), 'PNG')
    icon.save(os.path.join(out_dir, 'ic_launcher_round.png'), 'PNG')
    icon.save(os.path.join(out_dir, 'ic_launcher_foreground.png'), 'PNG')
    print(f'  {folder}: {size}x{size}')

# 启动页：白色背景 + 居中头像
for folder, (w, h) in SPLASH_SIZES.items():
    bg = Image.new('RGBA', (w, h), (255, 255, 255, 255))
    avatar_size = min(w, h) // 2
    resized = avatar.resize((avatar_size, avatar_size), Image.LANCZOS)
    bg.paste(resized, ((w - avatar_size) // 2, (h - avatar_size) // 2), resized)
    out_dir = os.path.join(BASE, folder)
    os.makedirs(out_dir, exist_ok=True)
    bg.save(os.path.join(out_dir, 'splash.png'), 'PNG')
    print(f'  {folder}: {w}x{h}')

# 通用 splash
bg = Image.new('RGBA', (1080, 1920), (255, 255, 255, 255))
avatar_s = avatar.resize((540, 540), Image.LANCZOS)
bg.paste(avatar_s, (270, 690), avatar_s)
bg.save(os.path.join(BASE, 'drawable', 'splash.png'), 'PNG')

# 背景色改为白色
bg_xml = '''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#FFFFFF</color>
</resources>'''
with open(os.path.join(BASE, 'values', 'ic_launcher_background.xml'), 'w', encoding='utf-8') as f:
    f.write(bg_xml)
with open(os.path.join(BASE, 'drawable', 'ic_launcher_background.xml'), 'w', encoding='utf-8') as f:
    f.write(bg_xml)

print('\nDone!')
