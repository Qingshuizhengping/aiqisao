#!/usr/bin/env bash
# AI 七嫂 · 一键部署（本地执行，把 optimized 推到服务器并重启 PM2）
#
# 用法：
#   AIQISAO_SSH_HOST=8.134.141.217 \
#   AIQISAO_SSH_USER=root \
#   AIQISAO_SSH_PASSWORD=xxxx \
#   bash optimized/deploy.sh
#
# 可选：
#   APP_DIR  服务器部署目录，默认 /opt/ai-qisao
#   PM2_NAME 仅支持已配置的 ai-qisao 进程
#   SKIP_BUILD=1 跳过本地构建
#
# 注意：不携带 .env 或 api/_config.js，不覆盖服务器密钥、模型、TLS、生成图或历史 APK。
set -euo pipefail

HOST=${AIQISAO_SSH_HOST:?缺少 AIQISAO_SSH_HOST}
USER=${AIQISAO_SSH_USER:?缺少 AIQISAO_SSH_USER}
PASS=${AIQISAO_SSH_PASSWORD:-}
APP_DIR=${APP_DIR:-/opt/ai-qisao}
PM2_NAME=${PM2_NAME:-ai-qisao}
REMOTE="$USER@$HOST"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="optimized"

[[ "$HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] && [[ "$HOST" != *..* ]] || { echo '无效的 AIQISAO_SSH_HOST' >&2; exit 1; }
[[ "$USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo '无效的 AIQISAO_SSH_USER' >&2; exit 1; }
[[ "$APP_DIR" =~ ^/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)+$ ]] || { echo 'APP_DIR 必须为不含特殊字符的绝对应用目录' >&2; exit 1; }
case "$APP_DIR" in /bin/*|/boot/*|/dev/*|/etc/*|/lib/*|/lib64/*|/proc/*|/run/*|/sys/*|/usr/*) echo '拒绝系统目录 APP_DIR' >&2; exit 1;; esac
[[ "$PM2_NAME" == ai-qisao ]] || { echo '此脚本仅允许发布 ai-qisao' >&2; exit 1; }
[[ "${SKIP_BUILD:-0}" == 0 || "${SKIP_BUILD:-0}" == 1 ]] || { echo 'SKIP_BUILD 只能为 0 或 1' >&2; exit 1; }

run() {
    if [ -n "$PASS" ]; then
        SSHPASS="$PASS" sshpass -e ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$REMOTE" "$@"
    else
        ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$REMOTE" "$@"
    fi
}

copy() {
    if [ -n "$PASS" ]; then
        SSHPASS="$PASS" sshpass -e scp -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$@"
    else
        scp -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$@"
    fi
}

cd "$ROOT/$OUT"

npm ci --ignore-scripts --no-audit --no-fund
npm test

# 1. 本地构建
if [ "${SKIP_BUILD:-0}" != "1" ]; then
    echo "==> 构建前端产物"
    python build.py
fi

# 2. 打包：只带运行必需的，不含 .env / node_modules / 生成图
echo "==> 打包"
umask 077
local_stage=$(mktemp -d "${TMPDIR:-/tmp}/aiqisao-release.XXXXXXXX")
archive="$local_stage/release.tgz"
remote_archive="/tmp/$(basename "$local_stage").tgz"
trap 'rm -f -- "$archive"; rmdir -- "$local_stage"' EXIT
tar czf "$archive" --exclude='public/static/gen' --exclude='public/downloads' \
    --exclude='*/.*' --exclude='*.apk' --exclude='*.aab' --exclude='*.pem' --exclude='*.key' \
    server.js api/_env.js api/image_config.js api/image_gen.js api/image_prompt.js api/optimizer_client.js api/image_policy.js api/image_jobs.js api/image_job_record.js api/image_job_store.js api/image_job_runner.js public package.json package-lock.json

# 3. 上传
echo "==> 上传到 $REMOTE"
copy "$archive" "$REMOTE:$remote_archive"

# 4. 服务器预检 + 私有备份 + 重启，失败恢复旧版本
echo "==> 服务器重启"
run "bash -s -- '$APP_DIR' '$PM2_NAME' '$remote_archive' '$HOST'" <<'REMOTE_SCRIPT'
set -euo pipefail
umask 077
app=$1
name=$2
archive=$3
host=$4
[[ "$archive" =~ ^/tmp/aiqisao-release\.[A-Za-z0-9]+\.tgz$ ]] || { echo 'Unsafe remote archive path' >&2; exit 1; }
trap 'rm -f -- "$archive"' EXIT
python3 - "$app" "$archive" <<'PY'
import sys, tarfile
from pathlib import Path, PurePosixPath
app = Path(sys.argv[1])
if not app.is_absolute() or app.resolve() != app or len(app.parts) < 3:
    raise SystemExit('Unsafe or symbolic application directory')
if not app.is_dir() or not (app / 'api/_config.js').is_file():
    raise SystemExit('Initial setup required: configure api/_config.js and provider credentials before deploying; the default model is never installed automatically.')
required = {'server.js', 'api/_env.js', 'api/image_config.js', 'api/image_gen.js', 'api/image_prompt.js', 'api/optimizer_client.js', 'api/image_policy.js', 'api/image_jobs.js', 'api/image_job_record.js', 'api/image_job_store.js', 'api/image_job_runner.js', 'package.json', 'package-lock.json'}
seen = set()
with tarfile.open(sys.argv[2]) as bundle:
    for member in bundle.getmembers():
        path = PurePosixPath(member.name)
        normalized = path.as_posix()
        if path.is_absolute() or '..' in path.parts or normalized != member.name.rstrip('/') or normalized in seen:
            raise SystemExit('Unsafe or duplicate archive member')
        seen.add(normalized)
        if not (member.isfile() or member.isdir()) or any(part.startswith('.') for part in path.parts):
            raise SystemExit('Unsupported archive member')
        if any(ord(character) < 32 for character in normalized):
            raise SystemExit('Invalid archive filename')
        if normalized not in required and path.parts[0] != 'public':
            raise SystemExit('Unexpected release file')
        if normalized == 'public/static/gen' or normalized.startswith('public/static/gen/') or normalized == 'public/downloads' or normalized.startswith('public/downloads/'):
            raise SystemExit('Persistent user files must not be included')
        if path.suffix.lower() in {'.apk', '.aab', '.pem', '.key'}:
            raise SystemExit('Private or persistent file included')
    if not required.issubset(seen) or 'public/index.html' not in seen:
        raise SystemExit('Incomplete release archive')
PY
stage=$(mktemp -d "$app/.deploy.XXXXXXXX")
mkdir -m 700 "$stage/incoming" "$stage/next" "$stage/previous" "$stage/failed"
tar xzf "$archive" -C "$stage/incoming" --no-same-owner --no-same-permissions
node --check "$stage/incoming/server.js"
for script in "$stage/incoming/api/"*.js; do node --check "$script"; done
pm2 jlist > "$stage/processes.json"
port=$(node --input-type=module - "$stage/processes.json" "$app" "$name" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const [file, app, name] = process.argv.slice(2);
const processes = JSON.parse(fs.readFileSync(file, 'utf8')).filter(entry => entry.name === name);
if (processes.length !== 1 || processes[0].pm2_env.exec_mode !== 'fork_mode' || path.resolve(processes[0].pm2_env.pm_exec_path) !== path.join(app, 'server.js')) throw new Error('Expected one fork-mode ai-qisao process matching APP_DIR; initialize the configured application first.');
const port = String(processes[0].pm2_env.PORT || 3000);
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid application port');
process.stdout.write(port);
JS
)
node --input-type=module - "$app" "$stage/incoming" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const [app, incoming] = process.argv.slice(2);
const current = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
const next = JSON.parse(fs.readFileSync(path.join(incoming, 'package.json'), 'utf8'));
const normalized = dependencies => JSON.stringify(Object.entries(dependencies || {}).sort(([first], [second]) => first.localeCompare(second)));
if (next.type !== 'module' || normalized(current.dependencies) !== normalized(next.dependencies)) throw new Error('Runtime dependencies changed; stage and validate dependencies separately before deployment. Existing node_modules will not be modified.');
for (const dependency of Object.keys(next.dependencies || {})) {
    if (!fs.existsSync(path.join(app, 'node_modules', dependency, 'package.json'))) throw new Error('Runtime dependency is missing; initialize dependencies before deployment.');
}
JS
curl -fsS --max-time 10 "http://127.0.0.1:$port/api/health" -o "$stage/health-before.json"
backup_root="$app-backups"
if [ -L "$backup_root" ]; then echo 'Symbolic backup directory is not allowed' >&2; exit 1; fi
install -d -m 700 "$backup_root"
backup=$(mktemp -d "$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-release.XXXXXXXX")
items=(server.js api public package.json package-lock.json)
for item in "${items[@]}"; do
    test -e "$app/$item"
    cp -a -- "$app/$item" "$backup/$item"
done
sha256sum "$app/api/_config.js" > "$backup/preserved.sha256"
if [ -f "$app/.env" ]; then sha256sum "$app/.env" >> "$backup/preserved.sha256"; fi
cp -a -- "$app/api" "$stage/next/api"
cp -a -- "$app/public" "$stage/next/public"
python3 - "$stage/incoming" "$stage/next" <<'PY'
import shutil, sys
from pathlib import Path
source, destination = map(Path, sys.argv[1:])
for item in source.rglob('*'):
    target = destination / item.relative_to(source)
    if any(parent.is_symlink() for parent in (target, *target.parents)):
        raise SystemExit('Refusing to overwrite a symbolic destination')
    if item.is_dir():
        target.mkdir(parents=True, exist_ok=True)
        if item.relative_to(source).parts[0] == 'public': target.chmod(0o755)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, target)
        if item.relative_to(source).parts[0] == 'public':
            target.chmod(0o644)
            if item.suffix not in {'.br', '.gz'}:
                for suffix in ('.br', '.gz'):
                    if not Path(str(item) + suffix).exists():
                        stale = Path(str(target) + suffix)
                        if stale.is_symlink():
                            raise SystemExit('Refusing a symbolic compressed destination')
                        stale.unlink(missing_ok=True)
PY
complete=0
rollback() {
    result=$?
    trap - EXIT
    if [ "$complete" -eq 0 ]; then
        echo "Release failed; restoring previous application. Backup: $backup" >&2
        for item in "${items[@]}"; do
            if [ -e "$stage/previous/$item" ]; then
                if [ -e "$app/$item" ]; then mv -- "$app/$item" "$stage/failed/$item"; fi
                mv -- "$stage/previous/$item" "$app/$item"
            fi
        done
        pm2 restart "$name" >/dev/null || { echo 'Rollback restart failed; manual recovery required' >&2; result=1; }
        [ "$result" -ne 0 ] || result=1
    fi
    rm -f -- "$archive"
    exit "$result"
}
trap rollback EXIT
pm2 stop "$name" >/dev/null
for persistent in static/gen downloads; do
    if [ -d "$app/public/$persistent" ] && [ ! -L "$app/public/$persistent" ]; then
        mkdir -p -- "$stage/next/public/$persistent"
        cp -a -- "$app/public/$persistent/." "$stage/next/public/$persistent/"
    fi
done
for item in "${items[@]}"; do
    mv -- "$app/$item" "$stage/previous/$item"
    mv -- "$stage/next/$item" "$app/$item"
done
sha256sum -c "$backup/preserved.sha256"
pm2 restart "$name" >/dev/null
healthy=0
for attempt in $(seq 1 15); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$port/api/health" -o "$stage/health-after.json" &&
        node -e 'const h=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.exit(h.status==="ok"&&h.imageJobsReady===true?0:1)' "$stage/health-after.json"; then healthy=1; break; fi
    sleep 1
done
test "$healthy" -eq 1
curl -fsS --max-time 15 "https://$host/api/health" -o "$stage/health-public.json"
node --input-type=module - "$stage/health-before.json" "$stage/health-after.json" "$stage/health-public.json" <<'JS'
import fs from 'node:fs';
const health = process.argv.slice(2).map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
if (!health[0].model || health.some(entry => entry.status !== 'ok' || entry.model !== health[0].model)) throw new Error('Health check failed or the configured model changed');
if (health.slice(1).some(entry => entry.imageJobsReady !== true)) throw new Error('Background image jobs are not ready');
console.log(JSON.stringify({ status: 'ok', model: health[0].model }));
JS
curl -fsS --max-time 15 "https://$host/sw.js" -o "$stage/sw.js"
grep -m1 'var VERSION' "$stage/sw.js"
curl -fsS --max-time 15 -o /dev/null "https://$host/image"
sha256sum -c "$backup/preserved.sha256"
complete=1
printf 'Rollback snapshot: %s\n' "$backup"
REMOTE_SCRIPT

echo "==> 完成"
