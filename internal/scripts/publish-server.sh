#!/usr/bin/env bash
# Run over the existing authenticated SSH connection on the configured Alibaba host.
# Input: git archive containing internal/ and optimized/src/, named with its commit.
set -euo pipefail
umask 077
export PATH=/opt/node-v24.22.1-linux-x64/bin:$PATH
archive=${1:?Usage: publish-server.sh /tmp/aiqisao-employee-COMMIT.tgz}
[[ "$archive" =~ ^/tmp/aiqisao-employee-([a-f0-9]{40})\.tgz$ ]] || exit 1
revision=${BASH_REMATCH[1]}
base=/opt/ai-qisao-internal
origin=https://8.134.141.217:6069
certificate=/etc/letsencrypt-aiqisao/live/aiqisao-ip
nginx_file=/etc/nginx/conf.d/ai-qisao-internal-6069.conf
previous=$(readlink -f "$base/current")
case "$previous" in "$base"/releases/*) ;; *) exit 1;; esac
test -f "$base/service.env"
openssl x509 -in "$certificate/fullchain.pem" -checkip 8.134.141.217 -noout >/dev/null
openssl x509 -in "$certificate/fullchain.pem" -checkend 86400 -noout >/dev/null
test -s "$certificate/privkey.pem"
if ss -ltnp '( sport = :6069 )' | tail -n +2 | grep -q .; then
    ss -ltnp '( sport = :6069 )' | tail -n +2 | grep -q nginx || { echo 'Port 6069 belongs to another service.'; exit 1; }
fi
python3 - "$archive" <<'PY'
import sys,tarfile
from pathlib import PurePosixPath
with tarfile.open(sys.argv[1]) as bundle:
    total=0
    for member in bundle.getmembers():
        name=member.name.rstrip('/')
        p=PurePosixPath(name)
        if p.is_absolute() or '..' in p.parts or p.as_posix()!=name or not (member.isfile() or member.isdir()):
            raise SystemExit('Unsafe archive member')
        if not (name=='internal' or name.startswith('internal/') or name=='optimized' or name=='optimized/src' or name.startswith('optimized/src/')):
            raise SystemExit('Unexpected archive path')
        if any(part in ('node_modules','var','dist') for part in p.parts) or p.name=='.env' or p.suffix in ('.key','.pem','.sqlite','.enc'):
            raise SystemExit('Private or generated files cannot be published')
        total+=member.size
        if total>64*1024*1024: raise SystemExit('Release is unexpectedly large')
PY
next=$(mktemp -d "$base/releases/employee-20261028.XXXXXX")
tar -xzf "$archive" -C "$next"
chown -hR qisao-internal:qisao-internal "$next"
chmod -R u+rwX,go-rwx "$next"
install -d -o qisao-internal -g qisao-internal -m 0700 "$base/npm-cache"
cd "$next/internal"
runuser -u qisao-internal -- env PATH="$PATH" npm ci --cache "$base/npm-cache" --no-audit --no-fund
runuser -u qisao-internal -- env PATH="$PATH" npm test
runuser -u qisao-internal -- env PATH="$PATH" npm run build
expected_version=$(node --input-type=module -e "import { VERSION } from './server.js'; process.stdout.write(VERSION)")
printf '%s\n' "$revision" > "$next/revision"
chown -hR root:qisao-internal "$next"
chmod -R g+rX,o-rwx "$next"
ln -s "$base/service.env" "$next/internal/.env"
cd "$previous/internal"
runuser -u qisao-internal -- node --input-type=module <<'JS'
import Database from 'better-sqlite3';
const db=new Database('/opt/ai-qisao-internal/data/internal.sqlite',{readonly:true});
const pending=db.prepare(`SELECT (SELECT COUNT(*) FROM chat_runs WHERE state IN ('queued','running'))+
 (SELECT COUNT(*) FROM memory_jobs WHERE state IN ('queued','running'))+
 (SELECT COUNT(*) FROM memory_index_jobs WHERE state IN ('queued','running'))+
 (SELECT COUNT(*) FROM knowledge_files WHERE processing_state IN ('queued','running') OR
 (status='active' AND processing_state='ready' AND index_state IN ('queued','running'))) AS count`);
const deadline=Date.now()+180000;
try {
 while(pending.get().count){
  if(Date.now()>deadline)throw new Error('Existing tasks are still active; release was not switched.');
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
} finally {db.close();}
JS
runuser -u qisao-internal -- node scripts/backup.mjs > "$base/pre-employee-backup.json"
rollback_dir=$(mktemp -d "$base/rollback-6069.XXXXXX")
cp -a "$base/service.env" "$rollback_dir/service.env"
if test -f "$nginx_file"; then cp -a "$nginx_file" "$rollback_dir/nginx.conf"; fi
old_mode=$(python3 -c 'import sys;print(next((x.split("=",1)[1].strip().strip("\"\x27") for x in open(sys.argv[1]) if x.startswith("NODE_ENV=")),"development"))' "$base/service.env")
old_origin=$(python3 -c 'import sys;print(next(x.split("=",1)[1].strip().strip("\"\x27") for x in open(sys.argv[1]) if x.startswith("INTERNAL_ORIGIN=")))' "$base/service.env")
activated=0
rollback() {
    status=${1:-1}
    trap - ERR HUP INT TERM
    set +e
    if test "$activated" = 1; then
        cp -a "$rollback_dir/service.env" "$base/service.env"
        if test -f "$rollback_dir/nginx.conf"; then cp -a "$rollback_dir/nginx.conf" "$nginx_file"; else rm -f -- "$nginx_file"; fi
        ln -s "$previous" "$base/current.rollback-$$"
        mv -Tf "$base/current.rollback-$$" "$base/current"
        env NODE_ENV="$old_mode" INTERNAL_ORIGIN="$old_origin" INTERNAL_HOST=127.0.0.1 INTERNAL_PORT=3001 pm2 restart ai-qisao-internal --update-env >/dev/null
        nginx -t && systemctl reload nginx
        echo 'Previous release, service configuration and HTTPS listener restored.'
    fi
    exit "$status"
}
trap 'rollback $?' ERR
trap 'rollback 129' HUP
trap 'rollback 130' INT
trap 'rollback 143' TERM
activated=1
python3 - "$base/service.env" <<'PY'
import os,sys,grp
from pathlib import Path
p=Path(sys.argv[1]); updates={'NODE_ENV':'production','INTERNAL_ORIGIN':'https://8.134.141.217:6069','INTERNAL_HOST':'127.0.0.1','INTERNAL_PORT':'3001'}
lines=[]; seen=set()
for line in p.read_text().splitlines():
    key=line.split('=',1)[0].strip()
    if key in updates:
        if key not in seen: lines.append(key+'='+updates[key]); seen.add(key)
    else: lines.append(line)
lines.extend(key+'='+value for key,value in updates.items() if key not in seen)
temporary=p.with_name(p.name+'.next')
temporary.write_text('\n'.join(lines)+'\n')
os.chown(temporary,0,grp.getgrnam('qisao-internal').gr_gid);os.chmod(temporary,0o640)
os.replace(temporary,p)
PY
cat > "$nginx_file" <<'NGINX'
server {
    listen 6069 ssl;
    server_name 8.134.141.217;
    ssl_certificate /etc/letsencrypt-aiqisao/live/aiqisao-ip/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt-aiqisao/live/aiqisao-ip/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 11m;
    error_page 497 =308 https://8.134.141.217:6069$request_uri;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_read_timeout 15m;
    }
}
NGINX
chmod 0644 "$nginx_file"
nginx -t
ln -s "$next" "$base/current.next-$$"
mv -Tf "$base/current.next-$$" "$base/current"
env NODE_ENV=production INTERNAL_ORIGIN="$origin" INTERNAL_HOST=127.0.0.1 INTERNAL_PORT=3001 pm2 restart ai-qisao-internal --update-env >/dev/null
healthy=0
for attempt in $(seq 1 25); do
    if curl -fsS http://127.0.0.1:3001/api/health 2>/dev/null | grep -Fq "\"version\":\"$expected_version\""; then healthy=1; break; fi
    sleep 1
done
test "$healthy" = 1
systemctl reload nginx
curl --connect-timeout 10 --max-time 15 --resolve 8.134.141.217:6069:127.0.0.1 -fsS "$origin/api/health"
anonymous=$(curl --resolve 8.134.141.217:6069:127.0.0.1 -sS -o /dev/null -w '%{http_code}' "$origin/api/auth/me")
test "$anonymous" = 401
redirect=$(curl --resolve 8.134.141.217:6069:127.0.0.1 -sS -o /dev/null -w '%{http_code}' http://8.134.141.217:6069/)
test "$redirect" = 308
pm2 save >/dev/null
printf '%s\n' "$previous" > "$base/pre-employee-release-path"
printf '%s\n' "$next" > "$base/staging-path"
trap - ERR HUP INT TERM
printf '\norigin=%s\nrevision=%s\nrelease=%s\nrollback=%s\n' "$origin" "$revision" "$next" "$rollback_dir"
