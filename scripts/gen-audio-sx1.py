#!/usr/bin/env python3
# 小禾数学示范课（sx1 因式分解·提公因式法）音频生成。
# 流程复用 scripts/gen-audio.py（英语已验证）：tts CLI 中文 → ffmpeg loudnorm -20 LUFS。
# 数学符号读法规范（TTS 文本全部用中文口语写出，不依赖引擎读符号）：
#   字母逐个读（ma → "m a"）；+ → 加；- → 减；= → 等于；× → 乘以；÷ → 除以；
#   x² → "x 平方"；(x+2) → "x 加 2 的和"；m(a+b) → "m 乘以 a 加 b 的和"。
# 本次示范只生成 1 段（sx1-teach-03，含公式，验证符号读法流程）。其余步骤音频待批量。
import json, re, subprocess, os, sys

BASE = os.path.expanduser('~/workspace/xiaohe-v2')
VOICE = 'avocado_v2:chip'   # Warm Pebble（Elouise 2026-09-29 选定，中英文同音色）
SPEED = 75                  # 中文默认（英语流程已验证）
RAW = '/tmp/xh-sx1-audio-raw'
OUT = os.path.join(BASE, 'audio', 'sx1')
os.makedirs(RAW, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

# audio_id → 中文口语文本（公式已按读法规范转写）
SEGMENTS = {
    'sx1-teach-03': (
        '提公因式，三句话：找公因式，提出来，乘回去验算。'
        '写成公式就是：m a 加 m b，等于 m 乘以 a 加 b 的和。'
        '下面开始办案。卡住了点老师教我。练熟了，换新案件考你。'
    ),
}

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print('FAILED:', ' '.join(cmd[:4]), r.stderr[-500:], file=sys.stderr)
        raise SystemExit(1)
    return r

for aid, text in SEGMENTS.items():
    raw = os.path.join(RAW, aid + '.mp3')
    out = os.path.join(OUT, aid + '.mp3')
    print(f'== {aid} [zh] {len(text)}字 speed={SPEED}', flush=True)
    run(['tts', 'speak', '--text', text, '--voice', VOICE, '--language', 'zh',
         '--speed', str(SPEED), '--output', raw])
    run(['ffmpeg', '-y', '-v', 'error', '-i', raw, '-af',
         'loudnorm=I=-20:TP=-1.5:LRA=11', '-ar', '24000', '-ac', '1', out])
    d = subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
                                 'format=duration', '-of', 'csv=p=0', out]).decode().strip()
    sz = os.path.getsize(out)
    print(f'   -> {out} {float(d):.1f}s {sz//1024}KB', flush=True)
print('DONE')
