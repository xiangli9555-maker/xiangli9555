#!/usr/bin/env python3
# 从「台词库总表」的 1.1声优锁 / 1.2音画同步 两页提取「已录入的需求（Story）」清单
# → 生成 deploy/backend/library_coverage.json
#
# 输入（stdin，JSON）：
#   {"release":"Yang1.0", "docid_hint":"...", "sheets":[{"sheet_id":"000001","sheet_name":"1.1声优锁","csv":"..."}, ...]}
# 输出（stdout，JSON）：
#   {"source":"wecom_sheet","docid_hint":...,"release":...,"fetched_at":...,
#    "sheets":[{"sheet_id","sheet_name","row_count"}],
#    "stories":[{"story","areas":[...],"sheet_ids":[...],"role_rows":N,"est_lines":N}],
#    "story_count":N,"role_row_count":N,"est_lines_total":N}
#
# 设计要点：
#   1) 列用表头名定位，不写死下标（1.1 六列 / 1.2 十列，结构会随总表演进）
#   2) 前 2 行是表头 + 填写人说明，数据从第 3 行（index 2）起
#   3) 只有 Story 非空的行才计数；跨页按 Story 归并，避免重复计数
import sys, csv, io, json, re
from datetime import datetime


def find_col(header, *candidates):
    """按表头名定位列下标；找不到返回 -1。candidates 按优先级排列，支持包含匹配。"""
    low = [(h or '').strip().lower() for h in header]
    for cand in candidates:
        c = cand.strip().lower()
        for i, h in enumerate(low):
            if h == c:
                return i
    for cand in candidates:
        c = cand.strip().lower()
        for i, h in enumerate(low):
            if c in h:
                return i
    return -1


def to_int(s):
    s = (s or '').strip()
    if not s:
        return 0
    try:
        return int(float(s))
    except (ValueError, TypeError):
        return 0


def parse_sheet(csv_text, sheet_id, sheet_name):
    rows = list(csv.reader(io.StringIO(csv_text or '')))
    if not rows:
        return sheet_id, sheet_name, [], 0
    header = rows[0]
    # 数据从第 3 行起（0=主表头，1=填写人说明）
    data_rows = rows[2:]

    i_story = find_col(header, 'Story', 'story', '需求', '任务名')
    i_area = find_col(header, 'Area', 'area')
    i_cat = find_col(header, '声优大类', '大类')
    i_role = find_col(header, '游戏角色（中）', '游戏角色(中)', '声优游戏角色', '游戏角色', '角色')
    i_lines = find_col(header, '预估句数', '句数')

    if i_story < 0:
        return sheet_id, sheet_name, [], 0

    out = []
    n = 0
    for row in data_rows:
        while len(row) <= max(i for i in (i_story, i_area, i_cat, i_role, i_lines) if i >= 0):
            row.append('')
        story = row[i_story].strip()
        if not story:
            continue
        n += 1
        out.append({
            'story': story,
            'area': row[i_area].strip() if i_area >= 0 else '',
            'category': row[i_cat].strip() if i_cat >= 0 else '',
            'role_cn': row[i_role].strip() if i_role >= 0 else '',
            'est_lines': to_int(row[i_lines]) if i_lines >= 0 else 0,
        })
    return sheet_id, sheet_name, out, n


def parse_payload(payload, default_release='Yang1.0', default_docid='台词库总表'):
    release = str(payload.get('release') or default_release)
    docid_hint = str(payload.get('docid_hint') or default_docid)
    sheets_in = payload.get('sheets') or []

    sheet_meta = []
    merged = {}   # story -> {areas, sheet_ids, role_rows, est_lines}
    role_rows = 0
    est_total = 0

    for sh in sheets_in:
        sid = str(sh.get('sheet_id') or '')
        sname = str(sh.get('sheet_name') or '')
        _, _, entries, n = parse_sheet(sh.get('csv') or '', sid, sname)
        sheet_meta.append({'sheet_id': sid, 'sheet_name': sname, 'row_count': n})
        for e in entries:
            key = e['story']
            slot = merged.get(key)
            if slot is None:
                slot = {'story': key, 'areas': [], 'sheet_ids': [], 'role_rows': 0, 'est_lines': 0}
                merged[key] = slot
            if e['area'] and e['area'] not in slot['areas']:
                slot['areas'].append(e['area'])
            if sid and sid not in slot['sheet_ids']:
                slot['sheet_ids'].append(sid)
            slot['role_rows'] += 1
            slot['est_lines'] += e['est_lines']
        role_rows += n
        est_total += sum(e['est_lines'] for e in entries)

    stories = sorted(merged.values(), key=lambda x: x['story'])
    return {
        'source': 'wecom_sheet',
        'docid_hint': docid_hint,
        'release': release,
        'fetched_at': datetime.now().replace(microsecond=0).isoformat(),
        'sheets': sheet_meta,
        'stories': stories,
        'story_count': len(stories),
        'role_row_count': role_rows,
        'est_lines_total': est_total,
    }


if __name__ == '__main__':
    payload = json.loads(sys.stdin.read() or '{}')
    result = parse_payload(payload)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write('\n')
    # 不向 stdout 打印任何计数/日志，避免污染 JSON
