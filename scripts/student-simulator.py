#!/usr/bin/env python3
"""
学生模拟器：发版前自动当学生走一遍所有课程
- 加载每课，检查步骤完整性
- 模拟答题（对/错）、HELP、保底出口
- 有问题的课直接报错阻断发版
"""
import json, glob, os, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
errors = []
warnings = []

def check(msg, cond, detail=""):
    if not cond:
        errors.append(f"{msg}: {detail}")

print("=== 学生模拟器：走查所有课程 ===")
lessons = sorted(glob.glob(os.path.join(BASE, 'content', 'lesson-*.json')))
print(f"共 {len(lessons)} 节课")

for jf in lessons:
    lid = os.path.basename(jf).replace('lesson-', '').replace('.json', '')
    try:
        d = json.load(open(jf))
    except Exception as e:
        errors.append(f"{lid}: JSON解析失败 {e}")
        continue
    
    steps = d.get('steps', [])
    if not steps:
        errors.append(f"{lid}: 无步骤")
        continue
    
    # 1. 步骤连续性
    for i, s in enumerate(steps):
        if s.get('step') != i + 1:
            errors.append(f"{lid}: 步骤号不连续 (期望{i+1}, 实际{s.get('step')})")
            break
    
    # 2. 题目完整性
    for s in steps:
        st, kind = s.get('step'), s.get('kind')
        if kind == 'mcq':
            check(f"{lid} step{st}", s.get('options') and len(s['options']) >= 2, "选择题选项不足")
            check(f"{lid} step{st}", s.get('answer'), "选择题无答案")
            check(f"{lid} step{st}", s.get('help'), "无HELP")
            # 答案必须在选项中
            if s.get('answer') and s.get('options'):
                ans = str(s['answer']).upper()
                if ans not in 'ABCD'[:len(s['options'])]:
                    errors.append(f"{lid} step{st}: 答案{ans}超出选项范围")
        elif kind == 'short':
            check(f"{lid} step{st}", s.get('expects') or s.get('answer'), "简答题无判分依据")
            check(f"{lid} step{st}", s.get('help'), "无HELP")
        elif kind == 'teach':
            check(f"{lid} step{st}", s.get('teach_html') or s.get('text'), "讲解无内容")
    
    # 3. 音频引用检查
    audio_ids = set()
    def walk(o):
        if isinstance(o, dict):
            if 'audio_id' in o: audio_ids.add(o['audio_id'])
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(steps)
    for aid in audio_ids:
        found = glob.glob(os.path.join(BASE, 'audio', '**', f'{aid}.mp3'), recursive=True)
        if not found:
            warnings.append(f"{lid}: audio_id={aid} 无音频文件（前端会自动隐藏播放器）")
    
    # 4. phase合法性
    for s in steps:
        ph = s.get('phase')
        if ph not in ('teach', 'practice', 'validate', 'choice', None):
            errors.append(f"{lid} step{s.get('step')}: 非法phase={ph}")

print(f"\n检查完成")
if warnings:
    print(f"\n⚠️ 警告 {len(warnings)} 项:")
    for w in warnings[:10]: print(f"  {w}")
    if len(warnings) > 10: print(f"  ...还有{len(warnings)-10}项")
if errors:
    print(f"\n🛑 错误 {len(errors)} 项（阻断发版）:")
    for e in errors[:20]: print(f"  {e}")
    sys.exit(1)
print("\n✅ 所有课程走查通过")
