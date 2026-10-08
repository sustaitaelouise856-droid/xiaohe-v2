#!/usr/bin/env python3
# 小禾数学 sx1/sx2/sx3 讲解音频批量生成（teach 步骤，共 21 段）。
# 流程复用 scripts/gen-audio.py（英语已验证）：tts CLI 中文 → ffmpeg loudnorm -20 LUFS。
# 数学符号读法规范（TTS 文本全部用中文口语写出，不依赖引擎读符号）：
#   字母逐个读（ma → "m a"）；x² → "x 平方"；(x+2) → "x 加 2 的和"；
#   3(x+2) → "3 乘以 x 加 2 的和"；(a+b)² → "a 加 b 的和平方"。
# 注意：题目步骤（mcq/short）不设 audio_id（与英语课一致，只给讲解配音），
#   生成前先 strip 问题步骤的 audio_id，避免前端出现 404 播放器。
import json, re, subprocess, os, sys

BASE = os.path.expanduser('~/workspace/xiaohe-v2')
VOICE = 'avocado_v2:chip'   # Warm Pebble（Elouise 2026-09-29 选定）
SPEED = 75                  # 中文默认
RAW = '/tmp/xh-sx-audio-raw'
os.makedirs(RAW, exist_ok=True)

def strip_html(h):
    t = re.sub(r'<[^>]+>', ' ', h or '')
    return re.sub(r'\s+', ' ', t).strip()

def paren_to_speech(m):
    inner = m.group(1)
    if '+' in inner:
        return inner + '的和'
    if '-' in inner:
        return inner + '的差'
    return inner

def math_to_speech(t):
    t = t.replace('\\(', '').replace('\\)', '').replace('$$', '。')
    t = t.replace('^2', '平方').replace('^3', '立方')
    t = t.replace('\\div', '除以').replace('\\times', '乘以').replace('\\cdot', '乘以')
    t = re.sub(r'([a-zA-Z])\(', r'\1乘以(', t)                # m(a+b) → m乘以(a+b)
    t = re.sub(r'\(([^()]*)\)', paren_to_speech, t)          # (x+2) → x+2的和
    t = re.sub(r'(\d)([a-zA-Z(])', r'\1乘以\2', t)            # 3x → 3乘以x
    t = re.sub(r'(?<=[a-zA-Z])(?=[a-zA-Z])', ' ', t)          # ma → m a
    t = re.sub(r'的和(?=[a-zA-Z(])', '的和乘以', t)           # 的和( → 的和乘以(
    t = re.sub(r'的差(?=[a-zA-Z(])', '的差乘以', t)
    t = re.sub(r'(?<=\d)(?=[a-zA-Z])', ' ', t)                # 3x → 3 x（保险）
    t = t.replace('×', '乘以').replace('·', '乘以')
    t = t.replace('+', '加').replace('=', '等于').replace('*', '乘以')
    t = t.replace('-', '减')                                 # en-dash – 不受影响
    t = re.sub(r'\s+', ' ', t).strip()
    return t

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print('FAILED:', ' '.join(cmd[:4]), r.stderr[-500:], file=sys.stderr)
        raise SystemExit(1)
    return r

LESSONS = ['sx1', 'sx2', 'sx3']
total = 0
for lid in LESSONS:
    fp = os.path.join(BASE, 'content', f'lesson-{lid}.json')
    if not os.path.exists(fp):
        print(f'跳过 {lid}（文件不存在）')
        continue
    lesson = json.load(open(fp, encoding='utf-8'))
    outdir = os.path.join(BASE, 'audio', lid)
    os.makedirs(outdir, exist_ok=True)
    for s in lesson['steps']:
        if s.get('kind') != 'teach':
            continue
        aid = s.get('audio_id')
        if not aid:
            continue
        text = math_to_speech(strip_html(s.get('teach_html', '')))
        if not text:
            continue
        raw = os.path.join(RAW, aid + '.mp3')
        out = os.path.join(outdir, aid + '.mp3')
        print(f'== {aid} {len(text)}字', flush=True)
        # print('   ', text[:60], flush=True)
        run(['tts', 'speak', '--text', text, '--voice', VOICE, '--language', 'zh',
             '--speed', str(SPEED), '--output', raw])
        run(['ffmpeg', '-y', '-v', 'error', '-i', raw, '-af',
             'loudnorm=I=-20:TP=-1.5:LRA=11', '-ar', '24000', '-ac', '1', out])
        total += 1
print(f'DONE {total} 段')
