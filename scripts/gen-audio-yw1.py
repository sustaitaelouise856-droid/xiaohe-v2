#!/usr/bin/env python3
# 小禾语文中文 TTS 流程验证（P0 任务）。
# 复用数学窗口已验证流程：tts CLI 中文 → ffmpeg loudnorm -20 LUFS。
# 本次只验证《记承天寺夜游》全文朗读（背诵跟读用）：正常速 + 慢速跟读版各 1 段。
# 发音未经过人耳验证，生成文件一律标 UNVERIFIED（沿用英语音频诚实标注规则）。
import os, subprocess, sys

BASE = os.path.expanduser('~/workspace/xiaohe-v2')
VOICE = 'avocado_v2:chip'   # Warm Pebble（Elouise 2026-09-29 选定，中英文同音色）
RAW = '/tmp/xh-yw1-audio-raw'
OUT = os.path.join(BASE, 'audio', 'yw-wenyan1')
os.makedirs(RAW, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

TEXT = ('元丰六年十月十二日夜，解衣欲睡，月色入户，欣然起行。'
        '念无与为乐者，遂至承天寺寻张怀民。怀民亦未寝，相与步于中庭。'
        '庭下如积水空明，水中藻荇交横，盖竹柏影也。'
        '何夜无月？何处无竹柏？但少闲人如吾两人者耳。')

SEGMENTS = {
    'yw-wenyan1-recite-01': 75,       # 正常速朗读
    'yw-wenyan1-recite-01-slow': 55,  # 慢速跟读
}

def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print('FAILED:', ' '.join(cmd[:4]), r.stderr[-500:], file=sys.stderr)
        raise SystemExit(1)
    return r

for aid, speed in SEGMENTS.items():
    raw = os.path.join(RAW, aid + '.mp3')
    out = os.path.join(OUT, aid + '.mp3')
    print(f'== {aid} [zh] {len(TEXT)}字 speed={speed}', flush=True)
    run(['tts', 'speak', '--text', TEXT, '--voice', VOICE, '--language', 'zh',
         '--speed', str(speed), '--output', raw])
    run(['ffmpeg', '-y', '-v', 'error', '-i', raw, '-af',
         'loudnorm=I=-20:TP=-1.5:LRA=11', '-ar', '24000', '-ac', '1', out])
    d = subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries',
                                 'format=duration', '-of', 'csv=p=0', out]).decode().strip()
    sz = os.path.getsize(out)
    # 非静音检查：mean_volume 不能是 -inf
    vd = subprocess.run(['ffmpeg', '-v', 'error', '-i', out, '-af', 'volumedetect',
                         '-f', 'null', '-'], capture_output=True, text=True).stderr
    mv = [l for l in vd.splitlines() if 'mean_volume' in l]
    print(f'   -> {out} {float(d):.1f}s {sz//1024}KB {mv[0].strip() if mv else "no-vol"}', flush=True)
print('DONE')
