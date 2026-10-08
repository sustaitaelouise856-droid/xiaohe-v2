#!/usr/bin/env python3
"""
内容库存监控 v1
每天跑一次：python3 scripts/content-inventory.py
输出：剩余可用天数 + 缺口预警
安全线：7 天。低于安全线时报警。
"""
import json, glob, os, sys

CONTENT_DIR = os.path.join(os.path.dirname(__file__), '..', 'content')
SAFE_DAYS = 7
MINUTES_PER_DAY = 60

files = sorted(glob.glob(os.path.join(CONTENT_DIR, 'lesson-*.json')))
lessons = []
for f in files:
    d = json.load(open(f))
    fn = os.path.basename(f).replace('.json', '')
    steps = d.get('steps', [])
    n_teach = sum(1 for s in steps if s.get('kind') == 'teach')
    n_mcq = sum(1 for s in steps if s.get('kind') == 'mcq')
    n_short = sum(1 for s in steps if s.get('kind') == 'short')
    minutes = n_teach * 1.5 + n_mcq * 1.0 + n_short * 1.5
    # 检查音频覆盖率
    n_audio = sum(1 for s in steps if s.get('audio_id'))
    lessons.append({'id': fn, 'steps': len(steps), 'minutes': minutes, 'audio': n_audio})

total_min = sum(l['minutes'] for l in lessons)
days = total_min / MINUTES_PER_DAY

print(f"课程数: {len(lessons)}, 预估总时长: {total_min:.0f} 分钟 ({days:.1f} 天)")
print(f"安全线 {SAFE_DAYS} 天: {'✅ 充足' if days >= SAFE_DAYS else '🛑 不足，需补内容！'}")

# 音频缺口
no_audio = [l['id'] for l in lessons if l['audio'] == 0]
if no_audio:
    print(f"\n⚠️ 无音频课程 ({len(no_audio)}): {', '.join(no_audio)}")

if days < SAFE_DAYS:
    sys.exit(1)
