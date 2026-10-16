const fs = require('fs');
const path = require('path');

const webDir = path.join(__dirname, 'web_app');
const template = fs.readFileSync(path.join(webDir, 'offline.html.TEMPLATE'), 'utf-8');
const onlinePage = fs.readFileSync(path.join(webDir, 'index.html'), 'utf-8');
const styles = fs.readFileSync(path.join(webDir, 'static', 'css', 'style.css'), 'utf-8');
const glassScript = fs.readFileSync(path.join(webDir, 'static', 'js', 'glass.js'), 'utf-8');
const viewportScript = fs.readFileSync(path.join(webDir, 'static', 'js', 'viewport.js'), 'utf-8');
const bodyMatch = onlinePage.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);

if (!bodyMatch) throw new Error('web_app/index.html must contain a body element.');

const body = bodyMatch[1]
  .replace(/<script\b[^>]*\bsrc=["'][^"']*app\.js["'][^>]*>\s*<\/script>/gi, '')
  .replace(/<script\b[^>]*\bsrc=["']\/?static\/js\/glass\.js["'][^>]*>\s*<\/script>/gi, () => '<script>\n' + glassScript + '\n</script>')
  .replace(/<script\b[^>]*\bsrc=["']\/?static\/js\/viewport\.js["'][^>]*>\s*<\/script>/gi, () => '<script>\n' + viewportScript + '\n</script>');
const dataUri = 'data:image/png;base64,' + fs.readFileSync(path.join(webDir, 'avatar.png')).toString('base64');
const result = template
  .replace('{{APP_STYLES}}', () => styles)
  .replace('{{APP_BODY}}', () => body)
  .replace(/\bsrc=(["'])\/?avatar\.png\1/g, 'src="' + dataUri + '"')
  .replace(/AVATAR_DATA_URI/g, dataUri);

if (/\{\{APP_(?:STYLES|BODY)\}\}/.test(result)) throw new Error('An offline page placeholder was not replaced.');

const wwwDir = path.join(__dirname, 'www');
fs.mkdirSync(wwwDir, { recursive: true });
fs.writeFileSync(path.join(wwwDir, 'index.html'), result, 'utf-8');
const noticesPath = path.join(webDir, 'static', 'THIRD_PARTY_NOTICES.txt');
if (fs.existsSync(noticesPath)) fs.copyFileSync(noticesPath, path.join(wwwDir, 'THIRD_PARTY_NOTICES.txt'));
console.log('Built www/index.html:', Buffer.byteLength(result, 'utf-8'), 'bytes');
