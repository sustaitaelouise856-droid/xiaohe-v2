#!/usr/bin/env python3
# 批量生成 u3r1-u6r5（20课）缺失的课程音频。
# 音色：Warm Pebble（avocado_v2:chip）。英文 speed 75；响度 loudnorm -20 LUFS，24kHz 单声道。
# 文本：从 JSON 步骤提取英文部分（reading / teach_html 英文句+术语 / mcq stem+选项 / short 英文词）。
# 纯中文无英文的步骤跳过（Warm Pebble 中文不可懂），记入 difficult 清单。
# 可重入：已存在且非空的 mp3 自动跳过。
import json, re, subprocess, os, sys

BASE = os.path.expanduser('~/workspace/xiaohe-v2')
VOICE = 'avocado_v2:chip'
SPEED = 75
RAW = '/tmp/xh-u3u6-raw'
os.makedirs(RAW, exist_ok=True)

def strip_html(h):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', h or '')).strip()

def extract(s):
    kind = s.get('kind')
    parts = []
    has_reading = bool(s.get('reading'))
    if has_reading:
        r = re.sub(r'\s*\n\s*', '. ', s['reading'].strip())
        r = re.sub(r'\s+', ' ', r).strip()
        if r and r[-1] not in '.!?':
            r += '.'
        parts.append(r)
    if kind == 'teach' and s.get('teach_html') and not has_reading:
        html = s['teach_html']
        text = strip_html(html)
        for m in re.finditer(r"[A-Z][A-Za-z0-9 ,'\-:;()/]*[.?!](?=\s|[（(]|$)", text):
            ms = m.group(0).strip()
            if len([w for w in ms.split() if re.match(r'^[A-Za-z]', w)]) >= 3:
                parts.append(ms)
        for t in re.findall(r'<strong>([^<]*)</strong>', html):
            t = t.strip()
            if re.match(r'^[A-Za-z][A-Za-z\s\-/]*$', t) and len(t) >= 2:
                parts.append(t)
        for m in re.finditer(r'[（(]([A-Za-z][A-Za-z\s\-,/]*)[)）]', text):
            if len(m.group(1).strip()) >= 2:
                parts.append(m.group(1).strip())
    if kind == 'mcq':
        stem = re.sub(r'_+', 'blank', s.get('stem', '') or '').strip()
        if re.search(r'[A-Za-z]{2,}', stem):
            parts.append(stem)
        opts = s.get('options', [])
        if opts:
            parts.append('. '.join([f"{chr(65+i)}. {o}" for i, o in enumerate(opts)]) + '.')
    if kind == 'short':
        text = strip_html(' '.join([(s.get(k) or '') for k in ('stem', 'task', 'scene')]))
        words = [w for w in re.findall(r'\b[A-Za-z][A-Za-z\-]*\b', text) if len(w) >= 2]
        seen, uniq = set(), []
        for w in words:
            if w.lower() not in seen:
                seen.add(w.lower())
                uniq.append(w)
        if uniq:
            parts.append('. '.join(uniq) + '.')
    uniq = []
    for p in parts:
        pl = p.lower()
        if not any(pl in u.lower() or u.lower() in pl for u in uniq):
            uniq.append(p)
    return ' '.join(uniq) if uniq else None

def gen_one(aid, text, out_path):
    raw = os.path.join(RAW, aid + '.raw.mp3')
    r = subprocess.run(['tts', 'speak', '--text', text, '--voice', VOICE,
                        '--language', 'en', '--speed', str(SPEED),
                        '--output', raw],
                       capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return f"TTS失败: {r.stderr[-200:]}"
    r = subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', raw, '-af',
                        'loudnorm=I=-20:TP=-1.5:LRA=11', '-ar', '24000', '-ac', '1',
                        out_path],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return f"ffmpeg失败: {r.stderr[-200:]}"
    # 验证
    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        return "文件为空"
    try:
        d = float(subprocess.check_output(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', out_path]).decode().strip())
    except Exception as e:
        return f"ffprobe失败: {e}"
    if d < 0.5:
        return f"时长过短: {d:.1f}s"
    if d > 300:
        return f"时长过长: {d:.1f}s"
    return None

def main():
    lessons = [f'u{u}r{r}' for u in range(3, 7) for r in range(1, 6)]
    # 可选：只处理指定的课
    if len(sys.argv) > 1:
        lessons = sys.argv[1:]
    total_ok, total_skip, total_fail = 0, 0, 0
    difficult = []
    failures = []
    for lid in lessons:
        d = json.load(open(os.path.join(BASE, 'content', f'lesson-{lid}.json'),
                           encoding='utf-8'))
        adir = os.path.join(BASE, 'audio', lid)
        os.makedirs(adir, exist_ok=True)
        for s in d['steps']:
            aid = s.get('audio_id')
            if not aid:
                continue
            out = os.path.join(adir, aid + '.mp3')
            if os.path.exists(out) and os.path.getsize(out) > 1024:
                total_skip += 1
                continue
            text = extract(s)
            if not text:
                difficult.append(f"{aid} ({s.get('kind')} step {s.get('step')})")
                continue
            err = gen_one(aid, text, out)
            if err:
                failures.append(f"{aid}: {err}")
                total_fail += 1
                print(f"  FAIL {aid}: {err}", flush=True)
            else:
                total_ok += 1
                if total_ok % 20 == 0:
                    print(f"  ... {lid} 已生成 {total_ok} 个", flush=True)
        print(f"[{lid}] 完成", flush=True)
    print(f"\n=== 汇总 ===")
    print(f"生成: {total_ok}, 跳过(已有): {total_skip}, 失败: {total_fail}")
    print(f"无英文(困难): {len(difficult)}")
    for x in difficult:
        print(f"  DIFF: {x}")
    if failures:
        print(f"失败清单:")
        for x in failures:
            print(f"  {x}")

if __name__ == '__main__':
    main()
