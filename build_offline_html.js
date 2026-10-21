const fs = require('fs');
const path = require('path');
const vm = require('vm');

const publicDir = path.join(__dirname, 'optimized', 'public');
const onlineUrl = 'https://8.134.141.217/';
const dataTypes = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript'
};

function readAsset(assetPath) {
  const relativePath = assetPath.replace(/^\//, '').split('?')[0];
  const filePath = path.resolve(publicDir, relativePath);
  if (!filePath.startsWith(publicDir + path.sep)) throw new Error('Invalid offline asset: ' + assetPath);
  return fs.readFileSync(filePath);
}

function assetDataUri(assetPath) {
  const extension = path.extname(assetPath.split('?')[0]);
  const mimeType = dataTypes[extension];
  if (!mimeType) throw new Error('Unsupported offline asset: ' + assetPath);
  return 'data:' + mimeType + ';base64,' + readAsset(assetPath).toString('base64');
}

function inlineScript(assetPath) {
  return readAsset(assetPath).toString('utf8')
    .replace(/(["'])\/api\/([^"']*)\1/g, (match, quote, route) => quote + onlineUrl + 'api/' + route + quote)
    .replace(/(["'])\/static\/img\/([^"']+)\1/g, (match, quote, filename) => quote + assetDataUri('/static/img/' + filename) + quote)
    .replace(/(["'])\/static\/js\/lightfield\.js\1/g, (match, quote) => quote + assetDataUri('/static/js/lightfield.js') + quote)
    .replace(/<\/script/gi, '<\\/script');
}

const offlineScript = `
(function () {
  'use strict';
  var onlineUrl = ${JSON.stringify(onlineUrl)};
  var banner = document.getElementById('offlineBanner');
  var userInput = document.getElementById('userInput');
  var sendButton = document.getElementById('sendBtn');
  var inputNote = document.getElementById('inputNote');
  var studioLink = document.querySelector('.studio-entry');
  var fetchOnline = window.fetch.bind(window);

  if (studioLink) {
    studioLink.title = '需要联网使用素材生成';
    var studioLabel = studioLink.querySelector('span:not([aria-hidden])');
    if (studioLabel) studioLabel.textContent = '素材生成 · 需联网';
  }

  window.fetch = function (resource, options) {
    var url = new URL(typeof resource === 'string' ? resource : resource.url, onlineUrl);
    if (url.origin === new URL(onlineUrl).origin && url.pathname.indexOf('/api/') === 0) {
      return Promise.reject(new Error('离线模式仅支持查看历史对话，请联网后返回在线版。'));
    }
    return fetchOnline(resource, options);
  };

  function showOfflineMode() {
    if (banner) banner.classList.add('show');
    if (sendButton) sendButton.disabled = true;
    if (userInput) {
      userInput.disabled = true;
      userInput.placeholder = '离线模式仅支持查看历史对话';
    }
    document.querySelectorAll('.quick-btn').forEach(function (button) { button.disabled = true; });
  }

  if (banner) {
    banner.replaceChildren(document.createTextNode('当前为内置离线页面，可查看此页面已保存的历史。提问请联网后返回在线版。'));
    var retryButton = document.createElement('button');
    retryButton.type = 'button';
    retryButton.className = 'glass offline-online-button';
    retryButton.textContent = '联网返回在线版';
    retryButton.addEventListener('click', function () { window.location.replace(onlineUrl); });
    banner.appendChild(retryButton);
  }
  if (inputNote) inputNote.textContent = '此页面不会跨源调用在线 API，也不会清除已保存的历史对话。';
  window.sendMessage = showOfflineMode;
  window.quickAsk = showOfflineMode;
  window.addEventListener('online', showOfflineMode);
  window.addEventListener('offline', showOfflineMode);
  showOfflineMode();
})();
`;

const result = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
  .replace(/<link\b(?=[^>]*\brel=["']manifest["'])[^>]*>\s*/gi, '')
  .replace(/<script\b[^>]*\bsrc=(["'])(\/static\/js\/[^"']+)\1[^>]*>\s*<\/script>/gi, (match, quote, assetPath) => '<script>\n' + inlineScript(assetPath) + '\n</script>')
  .replace(/\b(src|srcset|href)=(["'])(\/static\/img\/[^"']+)\2/g, (match, attribute, quote, assetPath) => attribute + '=' + quote + assetDataUri(assetPath) + quote)
  .replace(/\bhref=(["'])\/image\1/g, 'href="' + onlineUrl + 'image"')
  .replace('</head>', '<style>.offline-banner.show{flex-shrink:0}.offline-online-button{min-height:44px;margin:8px 0 0 10px;padding:8px 16px;border-radius:999px;font-weight:600}</style>\n</head>')
  .replace('</body>', '<script>\n' + offlineScript + '\n</script>\n</body>');

if (/\b(?:src|srcset|href)=["']\/static\//.test(result)) throw new Error('An offline asset was not inlined.');
if (/(["'])\/api\/query(?:_stream)?\1/.test(result)) throw new Error('An offline API URL is not absolute.');
if (!result.includes('qisao_conversations')) throw new Error('The shared application history storage is missing.');
for (const script of result.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);

const wwwDir = path.join(__dirname, 'www');
fs.mkdirSync(wwwDir, { recursive: true });
fs.writeFileSync(path.join(wwwDir, 'index.html'), result, 'utf8');
const noticesPaths = [
  path.join(publicDir, 'THIRD_PARTY_NOTICES.txt'),
  path.join(__dirname, 'web_app', 'static', 'THIRD_PARTY_NOTICES.txt')
];
const notices = noticesPaths.filter(noticesPath => fs.existsSync(noticesPath)).map(noticesPath => fs.readFileSync(noticesPath, 'utf8'));
if (notices.length) fs.writeFileSync(path.join(wwwDir, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'), 'utf8');
console.log('Built shared optimized www/index.html:', Buffer.byteLength(result, 'utf8'), 'bytes');
