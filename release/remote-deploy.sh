#!/usr/bin/env bash
# 由根目录 release.sh 上传并调用。只部署已经成功 push 的 Git HEAD 包。
set -Eeuo pipefail
ARCHIVE="${1:?missing archive}"
ARCHIVE_SHA_FILE="${2:?missing archive sha256}"
COMMIT="${3:?missing commit}"
DEPLOY="/root/deploy"
BACKUP="/root/deploy/backups/release_${COMMIT}_$(date +%Y%m%d_%H%M%S)"
STAGE="/tmp/vomi-stage-${COMMIT}"

trap 'echo "✗ CVM 部署失败；备份在：'$BACKUP'" >&2' ERR
rm -rf "$STAGE"
mkdir -p "$STAGE" "$BACKUP"
EXPECTED_ARCHIVE_SHA="$(tr -d '[:space:]' < "$ARCHIVE_SHA_FILE")"
ACTUAL_ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
[[ -n "$EXPECTED_ARCHIVE_SHA" && "$ACTUAL_ARCHIVE_SHA" == "$EXPECTED_ARCHIVE_SHA" ]] || { echo "部署包 SHA256 不匹配"; exit 1; }
tar -xzf "$ARCHIVE" -C "$STAGE"
[[ -d "$STAGE/deploy/frontend" && -d "$STAGE/deploy/backend" ]] || { echo "部署包结构错误"; exit 1; }

# 保护服务器真实环境文件：包内不应包含 .env/runtime/secrets，但这里再做防线。
rm -f "$STAGE/deploy/.env" "$STAGE/deploy/backend/.env"
rm -rf "$STAGE/deploy/secrets" "$STAGE/deploy/backend/runtime"
# 持久化文件必须在覆盖/启动前存在；内容不进入Git包。
umask 077
mkdir -p "$DEPLOY/secrets" "$DEPLOY/backend/runtime"
[[ -f "$DEPLOY/backend/runtime/demand_jobs.json" ]] || printf '[]' > "$DEPLOY/backend/runtime/demand_jobs.json"
[[ -f "$DEPLOY/secrets/tencent_docs_token" ]] || { echo "缺少持久化凭证：$DEPLOY/secrets/tencent_docs_token"; exit 1; }
[[ -f "$DEPLOY/secrets/tencent_docs_oa_token" ]] || : > "$DEPLOY/secrets/tencent_docs_oa_token"
chmod 600 "$DEPLOY/backend/runtime/demand_jobs.json" "$DEPLOY/secrets/tencent_docs_token" "$DEPLOY/secrets/tencent_docs_oa_token"

# 覆盖前计算变化类型，确保“按变化重启/重建”。
FRONTEND_CHANGED=0
BACKEND_CHANGED=0
COMPOSE_CHANGED=0
NGINX_CHANGED=0
if [[ ! -d "$DEPLOY/frontend" ]] || ! diff -qr "$STAGE/deploy/frontend" "$DEPLOY/frontend" >/dev/null 2>&1; then FRONTEND_CHANGED=1; fi
if [[ ! -d "$DEPLOY/backend/src" ]] || ! diff -qr "$STAGE/deploy/backend/src" "$DEPLOY/backend/src" >/dev/null 2>&1; then BACKEND_CHANGED=1; fi
for f in Dockerfile package.json package-lock.json cw_doc_recipe_v6.js build_cw_doc.js; do
  [[ -f "$STAGE/deploy/backend/$f" ]] || continue
  cmp -s "$STAGE/deploy/backend/$f" "$DEPLOY/backend/$f" || BACKEND_CHANGED=1
done
[[ -f "$STAGE/deploy/docker-compose.yml" ]] && ! cmp -s "$STAGE/deploy/docker-compose.yml" "$DEPLOY/docker-compose.yml" && COMPOSE_CHANGED=1
[[ -f "$STAGE/deploy/nginx/default.conf" ]] && ! cmp -s "$STAGE/deploy/nginx/default.conf" "$DEPLOY/nginx/default.conf" && NGINX_CHANGED=1

echo "变化检测：frontend=$FRONTEND_CHANGED backend=$BACKEND_CHANGED compose=$COMPOSE_CHANGED nginx=$NGINX_CHANGED"

# 备份当前运行态的源码与配置（不复制 audio、mysql、certs 等大数据）。
for item in frontend backend/src backend/runtime/demand_jobs.json backend/Dockerfile backend/package.json backend/package-lock.json backend/cw_doc_recipe_v6.js docker-compose.yml nginx/default.conf; do
  if [[ -e "$DEPLOY/$item" ]]; then
    mkdir -p "$BACKUP/$(dirname "$item")"
    cp -a "$DEPLOY/$item" "$BACKUP/$item"
  fi
done
printf '%s\n' "$COMMIT" > "$BACKUP/target-commit.txt"

# 以 Git 包为真源覆盖正式源码；保留服务器 .env、certs、数据卷。
mkdir -p "$DEPLOY/frontend" "$DEPLOY/backend/src" "$DEPLOY/nginx"
cp -a "$STAGE/deploy/frontend/." "$DEPLOY/frontend/"
cp -a "$STAGE/deploy/backend/src/." "$DEPLOY/backend/src/"
for f in Dockerfile package.json package-lock.json cw_doc_recipe_v6.js build_cw_doc.js roster.json tapd-snapshot.js .env.example; do
  [[ -f "$STAGE/deploy/backend/$f" ]] && cp -a "$STAGE/deploy/backend/$f" "$DEPLOY/backend/$f"
done
[[ -f "$STAGE/deploy/docker-compose.yml" ]] && cp -a "$STAGE/deploy/docker-compose.yml" "$DEPLOY/docker-compose.yml"
[[ -f "$STAGE/deploy/nginx/default.conf" ]] && cp -a "$STAGE/deploy/nginx/default.conf" "$DEPLOY/nginx/default.conf"

# 已在覆盖前校验 Git archive 包的 SHA256；下方直接从该包展开部署。
cd "$DEPLOY"
# 后端以镜像为准；只有后端/compose 变化才重建。前端为 bind mount，只需重启 nginx。
if [[ $BACKEND_CHANGED -eq 1 || $COMPOSE_CHANGED -eq 1 ]]; then
  docker compose build --no-cache backend
  docker compose up -d backend
else
  echo "= 后端未变化，跳过重建"
fi
if [[ $FRONTEND_CHANGED -eq 1 || $NGINX_CHANGED -eq 1 || $COMPOSE_CHANGED -eq 1 ]]; then
  docker compose up -d nginx
  docker restart vo-nginx >/dev/null
else
  echo "= 前端/nginx 未变化，跳过重启"
fi

# 等待健康；不依赖登录 token。
for i in $(seq 1 30); do
  code="$(curl -s -o /tmp/vomi-health.json -w '%{http_code}' http://localhost/api/health || true)"
  [[ "$code" == "200" ]] && break
  sleep 2
done
[[ "${code:-000}" == "200" ]] || { docker logs vo-backend --tail 80 >&2; exit 1; }

# 关键页面和关键数据接口验证。
for url in \
  /vo-manager-refined.html \
  /preview-需求汇总-精修版.html \
  /preview-版本节点-精修版.html \
  /api/demands \
  /api/release-plans; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost$url" || true)"
  [[ "$code" == "200" ]] || { echo "HTTP 检查失败：$url => $code"; exit 1; }
done

printf '%s\n' "$COMMIT" > "$DEPLOY/DEPLOYED_GIT_COMMIT"
rm -rf "$STAGE" "$ARCHIVE" "$ARCHIVE_SHA_FILE" "$0"
echo "✓ CVM 部署成功：$COMMIT"
echo "✓ 备份：$BACKUP"
