import base64, urllib.request, io
from PIL import Image

# Download and resize icon
url = 'https://aka.doubaocdn.com/s/vQH41wbtOO'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
data = urllib.request.urlopen(req).read()
img = Image.open(io.BytesIO(data))
if img.mode != 'RGBA':
    img = img.convert('RGBA')
img = img.resize((120, 120), Image.LANCZOS)
buf = io.BytesIO()
img.save(buf, format='PNG', optimize=True)
b64 = base64.b64encode(buf.getvalue()).decode('ascii')

# Generate mobileconfig with icon
config = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>FullScreen</key>
            <true/>
            <key>Icon</key>
            <data>{b64}</data>
            <key>IsRemovable</key>
            <true/>
            <key>Label</key>
            <string>AI\u4e03\u5ac2</string>
            <key>PayloadDescription</key>
            <string>\u5728\u4e3b\u5c4f\u5e55\u6dfb\u52a0 AI\u4e03\u5ac2 Web \u5e94\u7528</string>
            <key>PayloadDisplayName</key>
            <string>AI\u4e03\u5ac2</string>
            <key>PayloadIdentifier</key>
            <string>com.weizhiyu.aiqisao.webclip</string>
            <key>PayloadType</key>
            <string>com.apple.webClip.managed</string>
            <key>PayloadUUID</key>
            <string>B2C3D4E5-F6A7-8901-BCDE-F12345678901</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>URL</key>
            <string>https://web-production-b0601.up.railway.app/</string>
            <key>IgnoreManifestScope</key>
            <false/>
        </dict>
    </array>
    <key>PayloadDescription</key>
    <string>\u5b89\u88c5\u8587\u4e4b\u96e8 AI\u4e03\u5ac2 Web \u5e94\u7528\u5230\u4e3b\u5c4f\u5e55</string>
    <key>PayloadDisplayName</key>
    <string>\u8587\u4e4b\u96e8 AI\u4e03\u5ac2</string>
    <key>PayloadIdentifier</key>
    <string>com.weizhiyu.aiqisao.profile</string>
    <key>PayloadOrganization</key>
    <string>\u8587\u4e4b\u96e8</string>
    <key>PayloadRemovalDisallowed</key>
    <false/>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>A1B2C3D4-E5F6-7890-ABCD-EF1234567890</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>'''

out = r'h:\新建文件夹\设计文件\樊清正\个人\nvwa\6.16版ai七嫂\ios\AI七嫂.mobileconfig'
with open(out, 'w', encoding='utf-8') as f:
    f.write(config)
print(f'Written {len(config)} bytes to mobileconfig')
