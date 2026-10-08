#!/usr/bin/env python3
"""语文示范课音频批量生成（中文 TTS）。
音色：avocado_v2:MAI_01（实测中文可懂；Warm Pebble 中文不可懂，禁用）
语言：--language zh；响度：-20 LUFS（沿用英语标准）
用法：python3 scripts/gen-audio-yw.py
"""
import json
import re
import os
import subprocess
import sys
import time

BASE = os.path.expanduser('~/workspace/xiaohe-v2')
OUT = os.path.join(BASE, 'audio', 'yuwen')
VOICE = 'avocado_v2:MAI_01'
TTS = '/opt/hatch/bin/tts'

LESSONS = ['lesson-yw1-zici.json', 'lesson-yw2-wenyan.json', 'lesson-yw3-yuedu.json']
OPEN_MARK = '【承上启下】'


def clean_html(h):
    t = re.sub(r'<[^>]+>', '', h or '')
    t = t.replace(OPEN_MARK, '')
    t = re.sub(r'\s+', ' ', t).strip()
    return t


def text_for(step):
    kind = step.get('kind')
    if kind == 'teach':
        return clean_html(step.get('teach_html', ''))
    return (step.get('stem') or '').strip()


def gen(audio_id, text):
    if not text:
        print('  SKIP %s（无文本）' % audio_id, flush=True)
        return True
    out = os.path.join(OUT, audio_id + '.mp3')
    if os.path.exists(out) and os.path.getsize(out) > 1000:
        print('  exists %s' % audio_id, flush=True)
        return True
    tmp = out + '.raw.mp3'
    ok = False
    for attempt in range(3):
        p = subprocess.run(
            [TTS, 'speak', '--voice', VOICE, '--language', 'zh',
             '--output', tmp, '--text-stdin'],
            input=text.encode('utf-8'), capture_output=True, timeout=180)
        if p.returncode == 0 and os.path.exists(tmp):
            ok = True
            break
        print('  retry %d %s' % (attempt + 1, audio_id), flush=True)
        time.sleep(5)
    if not ok:
        print('  FAIL %s' % audio_id, flush=True)
        return False
    q = subprocess.run(
        ['ffmpeg', '-y', '-v', 'error', '-i', tmp,
         '-af', 'loudnorm=I=-20:TP=-1.5:LRA=11', '-ar', '24000', out],
        capture_output=True, timeout=120)
    try:
        os.remove(tmp)
    except OSError:
        pass
    if q.returncode != 0 or not os.path.exists(out):
        print('  NORM-FAIL %s' % audio_id, flush=True)
        return False
    print('  ok %s (%d字)' % (audio_id, len(text)), flush=True)
    return True


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = []
    for fn in LESSONS:
        d = json.load(open(os.path.join(BASE, 'content', fn)))
        for s in d['steps']:
            aid = s.get('audio_id')
            if aid:
                jobs.append((aid, text_for(s)))
    print('共 %d 段' % len(jobs), flush=True)
    ok = 0
    fail = 0
    for aid, text in jobs:
        if gen(aid, text):
            ok += 1
        else:
            fail += 1
    print('完成：成功 %d，失败 %d' % (ok, fail), flush=True)
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())
