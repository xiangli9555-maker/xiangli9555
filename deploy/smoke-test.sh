#!/bin/bash
# ============================================================
# Vo Manager · 部署后冒烟测试（Go/No-Go 闸门 G5）
# 用法：
#   bash smoke-test.sh http://localhost <ADMIN_TOKEN>
#   BASE_URL=https://vo.example.com TOKEN=xxx bash smoke-test.sh
# 退出码：全部通过=0；任一失败=1
# ============================================================
set -u
BASE_URL="${1:-${BASE_URL:-http://localhost}}"
TOKEN="${2:-${TOKEN:-}}"

if [ -z "$TOKEN" ]; then
  echo "⚠ 未提供 Token：需设置 TOKEN 或第 2 参数。仅能测 /api/health（免鉴权）。"
fi

AUTH_H="-H Authorization: Bearer ${TOKEN}"
pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
no(){ echo "  ✗ $1"; fail=$((fail+1)); }

echo "══════════════════════════════════════════════"
echo "  Vo Manager 冒烟测试 · $BASE_URL"
echo "══════════════════════════════════════════════"

# 1. 健康检查（免鉴权）
if curl -fsS "$BASE_URL/api/health" >/tmp/vo_h.json 2>/dev/null; then ok "health $(cat /tmp/vo_h.json)"; else no "health 无响应"; fi

if [ -n "$TOKEN" ]; then
  # 2. 统一日期引擎
  if curl -fsS $AUTH_H "$BASE_URL/api/calendar?year=2026" >/dev/null 2>&1; then ok "calendar 200"; else no "calendar 失败"; fi

  # 3. 实时发布计划（本地真源 + 可选 DFAI）
  if curl -fsS $AUTH_H "$BASE_URL/api/release-plans" | grep -q '"success"'; then ok "release-plans 返回"; else no "release-plans 异常"; fi

  # 4. 日历节点
  if curl -fsS $AUTH_H "$BASE_URL/api/calendar-entries?releaseId=ma4" >/dev/null 2>&1; then ok "calendar-entries 200"; else no "calendar-entries 失败"; fi

  # 5. talent 命名别名（与 voice_roles 同一 handler）
  if curl -fsS $AUTH_H "$BASE_URL/api/talents" >/dev/null 2>&1; then ok "talents(别名) 200"; else no "talents 失败"; fi

  # 6. 历史 voice-roles 入口（应仍可用）
  if curl -fsS $AUTH_H "$BASE_URL/api/voice-roles" >/dev/null 2>&1; then ok "voice-roles(历史) 200"; else no "voice-roles 失败"; fi

  # 7. 存储配额
  if curl -fsS $AUTH_H "$BASE_URL/api/storage/quota" | grep -q '"quota"'; then ok "storage/quota 返回"; else no "storage/quota 异常"; fi

  # 8. 鉴权拦截：无 token 应 401
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/talents")
  if [ "$code" = "401" ]; then ok "无 token 被拒(401)"; else no "鉴权未生效(得到 $code)"; fi
else
  echo "  · 跳过需鉴权的检查（未提供 Token）"
fi

echo "────────────────────────────────────────────"
echo "  通过 $pass · 失败 $fail"
echo "══════════════════════════════════════════════"
[ "$fail" -eq 0 ]
