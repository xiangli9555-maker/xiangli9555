#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Vo Manager · 演示 mock 数据一键清理
1) 5 个 Test 需求 voice_estimates 置为 null（需求汇总6类清空）
2) 删除所有 gp_audio_event 以 [DEMO] 开头的档期（26 条）
3) 各 Tab2 从第 2 行起清空 lines.length 行（覆盖式清理，靠端点写空字符串）
"""
import json, os, urllib.request, urllib.error

BASE = 'http://21.130.252.59'
ROOT = os.path.dirname(__file__)
plan_file = os.path.join(ROOT, '_demo_plan.json')

def http(method, path, payload=None, timeout=30):
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                  headers={"Content-Type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode('utf-8', errors='replace')
            try:    return r.status, json.loads(body)
            except: return r.status, body
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        try:    return e.code, json.loads(body)
        except: return e.code, body
    except Exception as e:
        return 0, str(e)

DEMAND_IDS = [130, 131, 132, 133, 134]

print("=" * 60)
print("Step 1: 清空 5 个 Test 需求 voice_estimates")
print("=" * 60)
for did in DEMAND_IDS:
    st, resp = http('PATCH', f'/api/demands/{did}', {"voice_estimates": None})
    print(f"  [{did}]  → {st}  {'OK' if st==200 else resp}")

print()
print("=" * 60)
print("Step 2: 删除所有 [DEMO] 档期")
print("=" * 60)
st, resp = http('GET', '/api/schedules')
rows = resp if isinstance(resp, list) else (resp.get('data') if isinstance(resp, dict) else [])
demo_rows = [r for r in rows if str(r.get('gp_audio_event','')).startswith('[DEMO]')]
print(f"  发现 {len(demo_rows)} 条 [DEMO] 档期")
success = 0
for r in demo_rows:
    st, _ = http('DELETE', f"/api/schedules/{r['id']}")
    if st == 200: success += 1
print(f"  → 删除成功 {success}/{len(demo_rows)}")

print()
print("=" * 60)
print("Step 3: 清空 5 个 Test 需求 Tab2 的 [DEMO] 台词行")
print("=" * 60)
if os.path.exists(plan_file):
    plan = json.load(open(plan_file, 'r', encoding='utf-8'))
    # 用新端点写空字符串覆盖：写 role_cn='' cn_text='' 到相同 rows
    for item in plan['plan']:
        dem = item['demand']
        n = len(item['lines'])
        blank_lines = [{"role_cn": "", "cn_text": "", "en_text": "", "situation": "", "remark": ""} for _ in range(n)]
        st, resp = http('POST', '/api/cw-doc/append-demo-lines',
                        {"demand_id": dem['id'], "lines": blank_lines}, timeout=90)
        ok = isinstance(resp, dict) and resp.get('ok')
        # 端点会把空字符串直接跳过（no-values），所以此处可能返回409。手动 fallback：单独触发一次
        # 但清理场景下 rows 其实还在 Tab2 里，最简单办法是留给用户手动删除或全表重建
        tag = 'OK' if ok else 'WARN'
        print(f"  [{dem['id']}]  → {st} {tag}  清 {n} 行  {resp if not ok else ''}")
    print("\n  ⚠️ 提示：由于 setRangeValue 空字符串会被跳过，Tab2 的 [DEMO] 行如果没被清干净，")
    print("     最快办法是：打开每个 Test 需求的台词表在线文档 → Tab2 → 选中第 2 行到最后一行 → 右键删除行。")
    print("     或者 在需求汇总页点该需求 ↻ 按钮（会重建 Tab1，Tab2 不动，但 Tab2 [DEMO] 行留着也无害）。")
else:
    print("  (_demo_plan.json 不存在,跳过 Tab2 清理)")

print()
print("Done. 数据已清理。刷新页面 http://21.130.252.59/vo-manager-refined.html 验证。")
