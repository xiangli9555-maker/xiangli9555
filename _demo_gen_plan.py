#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Vo Manager · 下午演示 mock 数据生成 & 推送脚本
- 5 个 Test 需求（id 130-134）：每需求随机 5-10 个角色（按 area 倾向匹配 module）
- voice_estimates 写入 → PATCH /api/demands/:id
- Tab1 刷新 → POST /api/cw-doc/refresh-stat（让 6 类汇总/Tab1 生效）
- 涉及的每个中文声优 book 1 天（本周~下周）→ POST /api/schedules
"""
import json, random, urllib.request, urllib.error, sys, os
from datetime import date, timedelta

BASE = os.environ.get('VO_CVM_HOST', 'http://<CVM_IP>')
ROSTER_JSON = os.path.join(os.path.dirname(__file__), '_demo_roster.json')
random.seed(2026818)  # 可复现

# ── 5 个 Test 需求（从线上 /api/demands 抓的） ─────────────
DEMANDS = [
    {"id": 134, "task_name": "Test 01- For Vo Manager别喊'蜂医',喊'疯医'", "area": "商业化"},
    {"id": 133, "task_name": "Test 02- For Vo Manager 围城定律",            "area": "SOL"},
    {"id": 132, "task_name": "test 04- For Vo Manager 赛季任务",             "area": "系统"},
    {"id": 131, "task_name": "Test 03- For Vo Manager 特勤处的兵",          "area": "系统"},
    {"id": 130, "task_name": "test 05- For Vo Manager 新干员777",           "area": "干员"},
]

# ── 每个 area 倾向的 module 分配（不是硬绑，只是提高中签概率） ──
AREA_MODULE_HINT = {
    "商业化":  ["干员", "指挥官"],        # Test 01
    "SOL":     ["Boss", "AI兵", "干员"],   # Test 02
    "系统":    ["AI系统音", "NPC"],       # Test 03/04
    "干员":    ["干员"],                   # Test 05
}
# 每需求角色数 5~10
MIN_ROLES, MAX_ROLES = 5, 10
LINES_PER_ROLE = 10

# ── 台词模板池（三角洲行动世界观占位） ─────────────────
LINE_TEMPLATES = {
    "指挥官": [
        "各小队注意，目标区域已锁定，按计划推进。",
        "情报确认——敌方在东侧有埋伏，绕行侧翼。",
        "撤离窗口打开，倒计时60秒。",
        "支援已在路上，坚持住阵地。",
        "呼叫全体，切换到二号频道。",
        "任务优先级已更新，注意接收指令。",
        "报告伤亡情况，医疗队随时待命。",
        "封锁通道，任何东西都不能过去。",
        "干得漂亮，继续保持警戒。",
        "所有单位注意，撤离点位坐标D7。",
    ],
    "干员": [
        "收到，正在向目标点移动。",
        "掩护我，我要过去了。",
        "弹药消耗过半，需要补给。",
        "东北方向有敌人火力！",
        "报告，目标已清除。",
        "任务完成，返回集合点。",
        "这里的动静不对，我先撤了。",
        "帮我看下侧翼,我进屋了。",
        "背后交给你了。",
        "接下来往哪儿走，指挥？",
    ],
    "Boss": [
        "你们这些蝼蚁,竟敢闯入我的领地。",
        "臣服吧,这是你们唯一的活路。",
        "力量,才是这个世界唯一的真理。",
        "让我看看,你还能撑多久。",
        "无谓的挣扎,只会让结局更痛苦。",
        "在真正的实力面前,你们不值一提。",
        "我等你们这一刻已经很久了。",
        "别以为你们赢了,这才刚刚开始。",
        "把你们的绝望,展示给我看。",
        "命运的天平,从来不在你们那边。",
    ],
    "AI兵": [
        "发现敌人!开火!",
        "有人!呼叫支援!",
        "该死,他们在这!",
        "包抄!别让他跑了!",
        "小心手雷!",
        "换弹!掩护我!",
        "撤退!撤退!",
        "解决他!",
        "他就在附近!找出来!",
        "我看见你了!",
    ],
    "NPC": [
        "长官,请问有什么需要帮助的?",
        "这里是货物中转站,可以补给弹药。",
        "外面很危险,你要小心。",
        "听说前线又有新消息了。",
        "生意还行吧,能糊口。",
        "这个物资你可以拿去,免费的。",
        "路过的时候记得给我带点药回来。",
        "祝你好运,朋友。",
        "他们说这一趟不太好走。",
        "多谢关照,常来常往。",
    ],
    "AI系统音": [
        "任务开始,当前区域:三角洲行动作战区。",
        "警告:检测到敌方无人机,请提高警惕。",
        "载具已就绪,可随时驾驶。",
        "已获得新道具:急救包。",
        "剩余存活时间:五分钟。",
        "撤离信号已激活,请前往指定坐标。",
        "任务失败,即将返回大厅。",
        "队友倒下,请立即救援。",
        "环境提示:此区域存在辐射污染。",
        "自动保存中……进度已同步。",
    ],
}


# ── 工具:HTTP ────────────────────────────────
def http(method, path, payload=None, timeout=20):
    url = BASE + path
    data = None
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode('utf-8', errors='replace')
            try:    return r.status, json.loads(body)
            except: return r.status, body
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        try:    return e.code, json.loads(body)
        except: return e.code, body


# ── 加载声优库 & 按 module 分桶 ──────────────
with open(ROSTER_JSON, 'r', encoding='utf-8') as f:
    roster = json.load(f)
roster = [r for r in roster if not r.get('is_deleted')]
buckets = {}
for r in roster:
    buckets.setdefault(r['module'], []).append(r)

# ── 为每需求生成角色 + 台词 + voice_estimates ─────
def pick_roles_for(area):
    hints = AREA_MODULE_HINT.get(area, ["干员","AI兵"])
    n = random.randint(MIN_ROLES, MAX_ROLES)
    pool = []
    # 前80%从hint桶,后20%从其余桶,增加多样性
    hint_target = int(n * 0.75)
    for m in hints:
        pool += buckets.get(m, [])
    if len(pool) < hint_target:
        # hint桶不够,补其它桶
        for m, arr in buckets.items():
            if m not in hints: pool += arr
    random.shuffle(pool)
    selected = pool[:hint_target]
    # 再从任意其余桶补齐到 n
    remain = [r for r in roster if r not in selected]
    random.shuffle(remain)
    selected += remain[:max(0, n - len(selected))]
    return selected[:n]


all_va_names = set()  # 涉及的中文声优,后面 book 档期用
plan = []
for dem in DEMANDS:
    roles = pick_roles_for(dem['area'])
    # voice_estimates 结构:{"指挥官":[{role_cn,role_en,estimated_lines,voice_actor(cn_va)}],...}
    ve = {}
    lines_out = []
    for role in roles:
        m = role['module']
        entry = {
            "role_cn": role['role_cn'],
            "role_en": role.get('role_en',''),
            "estimated_lines": LINES_PER_ROLE,
            "cn_va": role.get('cn_va',''),
            "en_va": role.get('en_va',''),
            "cn_studio": role.get('cn_studio',''),
            "en_studio": role.get('en_studio',''),
            "role_id": role['id'],
        }
        ve.setdefault(m, []).append(entry)
        if role.get('cn_va'): all_va_names.add(role['cn_va'])
        # 生成 10 句台词(打上 [DEMO] 前缀)
        tpl = LINE_TEMPLATES.get(m, LINE_TEMPLATES['NPC'])
        for i in range(LINES_PER_ROLE):
            lines_out.append({
                "module": m,
                "role_cn": role['role_cn'],
                "line_no": f"L{i+1:02d}",
                "cn_text": f"[DEMO] {tpl[i % len(tpl)]}",
                "en_text": f"[DEMO] Line {i+1} for {role.get('role_en','')}",
                "situation": "演示占位",
            })
    plan.append({"demand": dem, "voice_estimates": ve, "lines": lines_out, "role_count": len(roles)})

print("=== mock plan ===")
for p in plan:
    print(f"  [{p['demand']['id']}] {p['demand']['task_name'][:32]}...  角色={p['role_count']}  台词={len(p['lines'])}  cn_va={sorted({e['cn_va'] for cat in p['voice_estimates'].values() for e in cat if e.get('cn_va')})}")
print(f"  涉及中文声优共 {len(all_va_names)} 位: {sorted(all_va_names)}")

# 落盘,后续步骤用
out_plan = os.path.join(os.path.dirname(__file__), '_demo_plan.json')
with open(out_plan, 'w', encoding='utf-8') as f:
    json.dump({"plan": plan, "cn_va_involved": sorted(all_va_names)}, f, ensure_ascii=False, indent=2)
print(f"\n✓ plan 已存: {out_plan}")
