#!/usr/bin/env python3
"""
小禾英语发版检查单 v1
每次推送 GitHub 前运行：python3 scripts/pre-deploy-check.py
红线项任一失败 → 禁止推送；警告项失败 → 记录但可推送
借鉴：Duolingo AI 内容护栏（自动检查+人工确认）
"""
import json, glob, re, os, sys

CONTENT_DIR = os.path.join(os.path.dirname(__file__), '..', 'content')
errors = []    # 红线：阻断发布
warnings = []  # 警告：记录但放行

def check(name, condition, msg, is_error=True):
    if not condition:
        (errors if is_error else warnings).append(f"[{name}] {msg}")

# 加载所有课程文件
files = sorted(glob.glob(os.path.join(CONTENT_DIR, '*.json')))
lessons = []
for f in files:
    try:
        d = json.load(open(f))
        lessons.append((os.path.basename(f), d))
    except Exception as e:
        errors.append(f"[JSON解析] {f}: {e}")

BANNED = ['很遗憾', '太棒了', '总体不错', '今天练得不错', '你真棒', '完美', '再想想', '选正确答案']
INTERNAL_PATTERNS = [r'step_\d+', r'item_[a-z0-9]{8,}', r'\bTODO\b', r'\bFIXME\b']

for fn, d in lessons:
    steps = d.get('steps', [])
    # 1. 禁用语
    for s in steps:
        for field in ['stem', 'teach_html', 'explain', 'task', 'title', 'help']:
            text = str(s.get(field, ''))
            clean = re.sub(r'<[^>]+>', '', text)
            for b in BANNED:
                check('禁用语', b not in clean, f"{fn} step {s.get('step')} 含'{b}'")
    # 2. 内部编号
    for s in steps:
        for field in ['stem', 'teach_html', 'task']:
            clean = re.sub(r'<[^>]+>', '', str(s.get(field, '')))
            for p in INTERNAL_PATTERNS:
                check('内部编号', not re.search(p, clean), f"{fn} step {s.get('step')} 疑似内部编号")
    # 3. 答案分布（mcq >= 8 题时检查；诊断卷降为警告）
    answers = [str(s['answer']).strip().upper() for s in steps
               if s.get('kind') == 'mcq' and str(s.get('answer', '')).strip().upper() in 'ABCD']
    is_diagnostic = fn.startswith('diagnostic-')
    if len(answers) >= 8:
        from collections import Counter
        c = Counter(answers)
        check('答案分布', max(c.values()) <= len(answers) * 0.5, f"{fn} 答案分布太偏: {dict(c)}",
              is_error=not is_diagnostic)
        max_run = cur = 1
        for i in range(1, len(answers)):
            cur = cur + 1 if answers[i] == answers[i-1] else 1
            max_run = max(max_run, cur)
        check('答案连续', max_run <= 2, f"{fn} 最长连续相同答案 {max_run} 次",
              is_error=not is_diagnostic)
    # 4. "请选择英文"类题目的选项检查
    for s in steps:
        if s.get('kind') == 'mcq' and '请选择英文' in str(s.get('stem', '')):
            opts = s.get('options', [])
            cn = sum(1 for o in opts if re.search(r'[\u4e00-\u9fff]', str(o)))
            check('中文干扰项', cn == 0, f"{fn} step {s.get('step')} '请选择英文'但有 {cn} 个中文选项")
    # 5. wrong_feedback 覆盖率（警告项）
    mcq = [s for s in steps if s.get('kind') == 'mcq']
    if mcq:
        wf = sum(1 for s in mcq if s.get('wrong_feedback'))
        check('错因反馈', wf / len(mcq) >= 0.8, f"{fn} wrong_feedback 覆盖率 {wf}/{len(mcq)}", is_error=False)
    # 6. 音频引用必须有文件（红线：缺失直接阻断）
    import glob as _glob
    audio_ids = set()
    def _walk(o):
        if isinstance(o, dict):
            if 'audio_id' in o: audio_ids.add(o['audio_id'])
            for v in o.values(): _walk(v)
        elif isinstance(o, list):
            for v in o: _walk(v)
    _walk(steps)
    for aid in sorted(audio_ids):
        found = _glob.glob(f'audio/**/{aid}.mp3', recursive=True)
        check('音频文件', len(found) > 0, f"{fn} audio_id={aid} 无对应mp3文件")  # 红线：缺音频禁止推送

# 学生模拟器：发版前自动走查所有课程（2026-10-09）
import subprocess as _sp
sim = _sp.run([sys.executable, os.path.join(os.path.dirname(__file__), 'student-simulator.py')],
              capture_output=True, text=True)
print(sim.stdout[-500:] if len(sim.stdout) > 500 else sim.stdout)
if sim.returncode != 0:
    errors.append("学生模拟器未通过，禁止推送")
    print(sim.stderr[:500])

print(f"\n检查 {len(lessons)} 个文件")
if warnings:
    print(f"\n⚠️ 警告 {len(warnings)} 项（可推送）：")
    for w in warnings[:10]: print(f"  {w}")
if errors:
    print(f"\n🛑 红线 {len(errors)} 项（禁止推送）：")
    for e in errors[:20]: print(f"  {e}")
    sys.exit(1)
print("\n✅ 全部红线通过，可以推送")
