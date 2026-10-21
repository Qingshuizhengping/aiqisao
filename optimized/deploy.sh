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
#   PM2_NAME PM2 进程名，默认 ai-qisao
#   SKIP_BUILD=1 跳过本地构建
#
# 注意：脚本不携带 .env，服务器的密钥由 .env 或 PM2 环境变量提供，不会被覆盖。
set -euo pipefail

HOST=${AIQISAO_SSH_HOST:?缺少 AIQISAO_SSH_HOST}
USER=${AIQISAO_SSH_USER:?缺少 AIQISAO_SSH_USER}
PASS=${AIQISAO_SSH_PASSWORD:-}
APP_DIR=${APP_DIR:-/opt/ai-qisao}
PM2_NAME=${PM2_NAME:-ai-qisao}
REMOTE="$USER@$HOST"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="optimized"

run() {
    if [ -n "$PASS" ]; then
        SSHPASS="$PASS" sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=20 "$REMOTE" "$@"
    else
        ssh -o StrictHostKeyChecking=no -o ConnectTimeout=20 "$REMOTE" "$@"
    fi
}

copy() {
    if [ -n "$PASS" ]; then
        SSHPASS="$PASS" sshpass -e scp -o StrictHostKeyChecking=no "$@"
    else
        scp -o StrictHostKeyChecking=no "$@"
    fi
}

cd "$ROOT/$OUT"

# 1. 本地构建
if [ "${SKIP_BUILD:-0}" != "1" ]; then
    echo "==> 构建前端产物"
    python build.py
fi

# 2. 打包：只带运行必需的，不含 .env / node_modules / 生成图
echo "==> 打包"
tar czf /tmp/aiqisao-release.tgz --exclude='public/static/gen' \
    server.js api public package.json package-lock.json

# 3. 上传
echo "==> 上传到 $REMOTE"
copy /tmp/aiqisao-release.tgz "$REMOTE:/tmp/aiqisao-release.tgz"

# 4. 服务器落盘 + 依赖 + 重启
echo "==> 服务器重启"
run "set -e
    mkdir -p '$APP_DIR'
    cd '$APP_DIR'
    tar xzf /tmp/aiqisao-release.tgz
    rm -f /tmp/aiqisao-release.tgz
    mkdir -p public/static/gen
    if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi
    pm2 restart '$PM2_NAME' --update-env >/dev/null 2>&1 || pm2 start server.js --name '$PM2_NAME'
    pm2 save >/dev/null 2>&1 || true
    sleep 2
    echo '--- 本地健康检查 ---'
    curl -sS -m 8 http://127.0.0.1:\${PORT:-3000}/api/health || echo '（端口可能不是 3000，以下方公网检查为准）'
"

# 5. 公网验证
echo "==> 公网验证"
curl -sS -m 15 -k "https://$HOST/api/health" && echo
curl -sS -m 15 -k "https://$HOST/sw.js" | grep -m1 "var VERSION"
curl -sS -m 15 -k -o /dev/null -w "GET /image -> HTTP %{http_code}\n" "https://$HOST/image"

echo "==> 完成"
