#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Vo Manager · 下午演示 mock 数据推送脚本(执行)
读 _demo_plan.json + _demo_actors.json,执行:
1) PATCH /api/demands/:id voice_estimates=... (5次)
2) POST /api/cw-doc/refresh-stat {demand_id} (5次,刷新Tab1)
3) POST /api/schedules × N (每中文声优 book 1天)
"""
import json, os, urllib.request, urllib.error, uuid, random, time
from datetime import date, timedelta

BASE = os.environ.get('VO_CVM_HOST', 'http://<CVM_IP>')
ROOT = os.path.dirname(__file__)
plan = json.load(open(os.path.join(ROOT, '_demo_plan.json'), 'r', encoding='utf-8'))
actors = json.load(open(os.path.join(ROOT, '_demo_actors.json'), 'r', encoding='utf-8'))
if isinstance(actors, dict): actors = actors.get('data', [])
va_by_name = {a['name']: a for a in actors}
random.seed(20268181)

def http(method, path, payload=None, timeout=25):
    url = BASE + path
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, method=method,
                                  headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode('utf-8', errors='replace')
            try: return r.status, json.loads(body)
            except: return r.status, body
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        try: return e.code, json.loads(body)
        except: return e.code, body
    except Exception as e:
        return 0, str(e)

# ============ 1. voice_estimates 写入 ============
print("=" * 60)
print("Step 1: PATCH voice_estimates × 5")
print("=" * 60)
for item in plan['plan']:
    dem = item['demand']
    ve = item['voice_estimates']
    st, resp = http('PATCH', f"/api/demands/{dem['id']}", {"voice_estimates": ve})
    ok = st in (200, 204)
    print(f"  [{dem['id']}] {dem['task_name'][:24]}...  → {st} {'OK' if ok else 'FAIL'}  {resp if not ok else ''}")

# ============ 2. Tab1 刷新 (refresh-stat) ============
print()
print("=" * 60)
print("Step 2: POST /api/cw-doc/refresh-stat × 5 (刷Tab1)")
print("=" * 60)
for item in plan['plan']:
    dem = item['demand']
    st, resp = http('POST', '/api/cw-doc/refresh-stat', {"demand_id": dem['id']}, timeout=60)
    ok = (isinstance(resp, dict) and resp.get('ok')) or st == 200
    print(f"  [{dem['id']}]  → {st} {'OK' if ok else 'WARN'}  rows={resp.get('rows') if isinstance(resp,dict) else '?'}  {resp.get('error','') if isinstance(resp,dict) else ''}")
    time.sleep(0.5)

# ============ 3. 录制档期 mock ============
print()
print("=" * 60)
print("Step 3: POST /api/schedules  (每中文声优 book 1天)")
print("=" * 60)
today = date.today()
# 本周~下周(工作日),跳过周末
work_days = []
for i in range(14):
    d = today + timedelta(days=i)
    if d.weekday() < 5:  # 0=Mon..4=Fri
        work_days.append(d)
print(f"  候选工作日: {[d.isoformat() for d in work_days]}")

# 每需求关联多个角色 → 归属 demand_id 池
# 简化:每中文声优随机挑一个 demand_id(如涉及多个,取第一次遇到)
va_to_demand = {}
for item in plan['plan']:
    dem_id = item['demand']['id']
    for cat, entries in item['voice_estimates'].items():
        for e in entries:
            va = e.get('cn_va')
            if va and va != 'AI生成' and va not in va_to_demand:
                va_to_demand[va] = {"demand_id": dem_id, "release_plan": "Yang1.0",
                                     "role_cn": e['role_cn'], "line_count": e['estimated_lines']}
print(f"  待 book 声优: {len(va_to_demand)}")

TIME_SLOTS = ["10:00-12:00", "14:00-16:00", "16:00-18:00"]
STUDIOS = ["居然翁", "北京·居然翁"]
success, fail = 0, 0
for va_name, meta in sorted(va_to_demand.items()):
    actor = va_by_name.get(va_name)
    if not actor:
        print(f"  ✗ {va_name}: actors表未找到,跳过")
        fail += 1
        continue
    rec_date = random.choice(work_days)
    slot = random.choice(TIME_SLOTS)
    payload = {
        "voice_actor_id": actor['id'],
        "record_date": rec_date.isoformat(),
        "language": "中文",
        "gp_audio_event": f"[DEMO] {meta['role_cn']}",
        "duration_hours": 2,
        "status": "confirmed",
        "demand_id": meta['demand_id'],
        "release_plan": meta['release_plan'],
        "studio": actor.get('portfolio_url','居然翁').split('·')[-1] if '·' in (actor.get('portfolio_url') or '') else '居然翁',
        "time_slot": slot,
        "line_count": meta['line_count'],
        "client_draft_id": f"demo-{uuid.uuid4().hex[:12]}"
    }
    st, resp = http('POST', '/api/schedules', payload)
    ok = (isinstance(resp, dict) and resp.get('ok')) or st in (200, 201)
    if ok:
        success += 1
    else:
        fail += 1
        print(f"  ✗ {va_name} @ {rec_date}: {st} {resp}")
print(f"  → 成功 {success} / 失败 {fail}")

print()
print("=" * 60)
print(f"Done. 打开 {BASE}/vo-manager-refined.html 查看效果。")
print("=" * 60)
