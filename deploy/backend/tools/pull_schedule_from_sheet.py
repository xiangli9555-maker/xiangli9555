#!/usr/bin/env python3
# 从 Vomi 台词库·3.录制档期 拉最新 CSV → 生成 deploy/backend/schedule_from_sheet.json
# 使用：先运行 wecom-cli sheet ranges get --json '{"docid":"...", "sheet_id":"rqt0n2", "mode":"csv"}'
#       把 CSV content 保存到 .workbuddy/tmp/schedule-latest.csv 再跑本脚本
#
# 或直接 stdin: python pull_schedule_from_sheet.py < input.csv > output.json
import sys, os, csv, io, json, re
from datetime import date, datetime

TODAY = date.today()

def norm_date(s):
    """归一日期字符串到 ISO YYYY-MM-DD；空 → ''；不能解析 → 原样"""
    s = (s or '').strip()
    if not s: return ''
    # 2026/9/22 or 2026-09-22
    m = re.match(r'^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$', s)
    if m:
        y, mo, d = int(m[1]), int(m[2]), int(m[3])
        return f'{y:04d}-{mo:02d}-{d:02d}'
    # 12月5日 → 缺年，按"离今天最近"推断（本年或次年）
    m = re.match(r'^(\d{1,2})月(\d{1,2})日$', s)
    if m:
        mo, d = int(m[1]), int(m[2])
        y = TODAY.year
        try:
            cand = date(y, mo, d)
        except ValueError:
            return s
        # 若候选日期比今天早超过 90 天，认定是次年
        if (TODAY - cand).days > 90:
            y += 1
        return f'{y:04d}-{mo:02d}-{d:02d}'
    return s

def first_nonempty(*args):
    for a in args:
        if a and str(a).strip(): return str(a).strip()
    return ''

def parse_csv(csv_text, release='Yang1', docid_hint='Vomi台词库-Yang1-test-v2', sheet_name='3.录制档期'):
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    # 前 3 行是表头（主表头 / 副表头 / 填写人说明）
    data_rows = rows[3:]
    records = []
    for row in data_rows:
        # 补齐到 26 列
        while len(row) < 26:
            row.append('')
        category = row[0].strip()
        role_cn = row[1].strip()
        if not category or not role_cn:
            continue
        role_type = row[2].strip()
        try:
            est_lines = int(float(row[3])) if row[3].strip() else 0
        except (ValueError, TypeError):
            est_lines = 0
        try:
            actual_lines = int(float(row[4])) if row[4].strip() and '%' not in row[4] else 0
        except (ValueError, TypeError):
            actual_lines = 0
        deviation = row[5].strip()  # 保留 "-80%" 字符串形式
        try:
            rec_count_cn = int(row[6]) if row[6].strip() else 0
        except ValueError:
            rec_count_cn = 0
        try:
            rec_count_en = int(row[7]) if row[7].strip() else 0
        except ValueError:
            rec_count_en = 0
        # 中/英 各 3 档次日期
        dates_cn = [norm_date(row[i]) for i in (8, 9, 10) if row[i].strip()]
        dates_en = [norm_date(row[i]) for i in (11, 12, 13) if row[i].strip()]
        date_cn = dates_cn[0] if dates_cn else ''
        date_en = dates_en[0] if dates_en else ''
        # 状态：有档期日期 → 已排期；无 → 待预约
        status_cn = '已排期' if date_cn else '待预约'
        status_en = '已排期' if date_en else '待预约'
        rec = {
            'category': category,
            'role_cn': role_cn,
            'role_type': role_type,
            'est_lines': est_lines,
            'actual_lines': actual_lines,
            'deviation': deviation,
            'va_cn': '',   # 新表无此列
            'va_en': '',
            'status_cn': status_cn,
            'status_en': status_en,
            'date_cn': date_cn,
            'date_en': date_en,
            'location': '',
            'note': '',
            # 扩展字段
            'rec_count_cn': rec_count_cn,
            'rec_count_en': rec_count_en,
            'dates_cn_all': dates_cn,
            'dates_en_all': dates_en,
        }
        records.append(rec)
    return {
        'source': 'wecom_sheet',
        'docid_hint': docid_hint,
        'sheet_name': sheet_name,
        'release': release,
        'fetched_at': datetime.now().replace(microsecond=0).isoformat(),
        'records': records,
    }

if __name__ == '__main__':
    csv_text = sys.stdin.read()
    result = parse_csv(csv_text)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write('\n')
    # 计数不再输出，避免调用方 2>&1 时污染 stdout JSON
