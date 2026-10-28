import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'dist');
await mkdir(path.join(destination, 'assets'), { recursive: true });
await build({ entryPoints: [path.join(root, 'src/app.js')], bundle: true, format: 'esm', target: 'es2019',
    minify: true, outfile: path.join(destination, 'assets/app.js'), legalComments: 'none' });
await build({ entryPoints: [path.join(root, 'src/style.css')], bundle: true, minify: true,
    target: ['safari15', 'chrome100'], outfile: path.join(destination, 'assets/style.css'), legalComments: 'none' });
const version = createHash('sha256').update(await readFile(path.join(destination, 'assets/app.js')))
    .update(await readFile(path.join(destination, 'assets/style.css')))
    .update(await readFile(path.join(root, 'public/static/img/avatar-192.png')))
    .update(await readFile(path.join(root, 'public/static/img/icon-192.png')))
    .update(await readFile(path.join(root, 'public/static/img/icon-512.png')))
    .update(await readFile(path.join(root, 'public/static/img/apple-touch-icon.png'))).digest('hex').slice(0, 12);
const html = (await readFile(path.join(root, 'src/index.html'), 'utf8'))
    .replace('/assets/app.js', '/assets/app.js?v=' + version).replace('/assets/style.css', '/assets/style.css?v=' + version);
await writeFile(path.join(destination, 'index.html'), html);
await cp(path.join(root, 'public'), destination, { recursive: true });
const worker = (await readFile(path.join(root, 'public/sw.js'), 'utf8')).replace('weizhiyu-internal-shell-v1', 'weizhiyu-internal-shell-' + version);
await writeFile(path.join(destination, 'sw.js'), worker);
const notices = await readFile(path.join(root, '../optimized/src/vendor/marked-18.0.9.LICENSE'), 'utf8');
await writeFile(path.join(destination, 'THIRD_PARTY_NOTICES.txt'), notices);
console.log(JSON.stringify({ built: true, version, directory: destination }));
