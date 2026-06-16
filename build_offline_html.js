const fs = require('fs');
const path = require('path');

// Read template
const template = fs.readFileSync('web_app/offline.html.TEMPLATE', 'utf-8');

// Read avatar.png and encode to base64
const avatarPath = path.join('web_app', 'avatar.png');
const avatarBuffer = fs.readFileSync(avatarPath);
const dataUri = 'data:image/png;base64,' + avatarBuffer.toString('base64');

// Replace placeholders
const result = template
  .replace(/AVATAR_DATA_URI/g, dataUri)
  .replace(/AVATAR_URI/g, dataUri);

// Ensure www directory exists
const wwwDir = 'www';
if (!fs.existsSync(wwwDir)) fs.mkdirSync(wwwDir, { recursive: true });

fs.writeFileSync(path.join(wwwDir, 'index.html'), result, 'utf-8');
console.log('Done! Size:', result.length, 'bytes');
