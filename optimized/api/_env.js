import { readFileSync } from 'node:fs';

let source = '';
try {
    source = readFileSync(new URL('../.env', import.meta.url), 'utf8');
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}

for (const line of source.split(/\r?\n/)) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    process.env[match[1]] = value;
}
