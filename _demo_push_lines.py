#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Vo Manager · 台词写入 Tab2（依赖新部署的 /api/cw-doc/append-demo-lines）
读 _demo_plan.json，逐需求 POST 到新端点。
"""
import json, os, urllib.request, urllib.error, time

BASE = 'http://21.130.252.59'
ROOT = os.path.dirname(__file__)
plan = json.load(open(os.path.join(ROOT, '_demo_plan.json'), 'r', encoding='utf-8'))

def http(method, path, payload=None, timeout=60):
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

print("=" * 60)
print("台词写入 Tab2 × 5 (每需求 ~50-80 行 [DEMO])")
print("=" * 60)

# 先探测端点是否可用
st, resp = http('POST', '/api/cw-doc/append-demo-lines', {"demand_id": "probe", "lines": [{"role_cn":"x","cn_text":"x"}]}, timeout=10)
if st == 404:
    print("✗ 端点不存在。请先部署新版本后端到 CVM (deploy-vo-manager.zip → bash deploy.sh)")
    print(f"  探测响应: {st} {resp}")
    exit(1)
elif st == 0:
    print(f"✗ 连接失败：{resp}")
    exit(1)
print(f"✓ 端点在线 (probe status={st}, 400 是正常的因为 demand_id=probe)")
print()

for item in plan['plan']:
    dem = item['demand']
    lines = item['lines']
    payload = {"demand_id": dem['id'], "lines": [
        {"role_cn": ln['role_cn'], "cn_text": ln['cn_text'], "en_text": ln['en_text'],
         "situation": ln['situation'], "remark": f"[DEMO] {ln['line_no']}"}
        for ln in lines
    ]}
    st, resp = http('POST', '/api/cw-doc/append-demo-lines', payload, timeout=120)
    ok = isinstance(resp, dict) and resp.get('ok')
    tag = 'OK' if ok else 'FAIL'
    print(f"  [{dem['id']}] {dem['task_name'][:26]}...  → {st} {tag}  写入{resp.get('rows') if ok else '?'}行  {resp.get('error','') if isinstance(resp,dict) else ''}")
    time.sleep(1)  # 避免打爆 sheet-mcp

print()
print("Done. 打开任意 Test 需求的台词表在线文档 → Tab2 应见 [DEMO] 台词行")
