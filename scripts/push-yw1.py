#!/usr/bin/env python3
"""推送语文示范课到 GitHub（sustaitaelouise856-droid/xiaohe-v2 main）。
用 Git Trees API 一次提交。认证：Elouise 的 GitHub PAT（custom.github-pat）。
只推本窗口的 3 节课 + 文档 + 音频，不动其他会话的文件。
"""
import sys
sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
from dynamic_credentials import dynamic_credential_entry
import json, urllib.request, urllib.error, base64, os

BASE = os.path.expanduser('~/workspace/xiaohe-v2')
OWNER = 'sustaitaelouise856-droid'
REPO = 'xiaohe-v2'
BRANCH = 'main'

FILES = [
    'content/lesson-yw1-zici.json',
    'content/lesson-yw2-wenyan.json',
    'content/lesson-yw3-yuedu.json',
    'docs/YUWEN-MASTER.md',
    'docs/YUWEN-TASKLIST.md',
    'scripts/gen-audio-yw.py',
    'scripts/push-yw1.py',
]

entry = dynamic_credential_entry('custom.github-pat', 'access_token')
token = str(entry['surrogate']).strip()

def gh(method, path, data=None, retries=4):
    import time as _t
    last = None
    for i in range(retries):
        req = urllib.request.Request(f'https://api.github.com{path}', method=method)
        req.add_header('Authorization', f'Bearer {token}')
        req.add_header('Accept', 'application/vnd.github.v3+json')
        req.add_header('User-Agent', 'Muse-Push')
        if data is not None:
            req.data = json.dumps(data).encode()
            req.add_header('Content-Type', 'application/json')
        try:
            resp = urllib.request.urlopen(req, timeout=120)
            return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            last = e
            print(f'  retry {i+1}/{retries}: HTTP {e.code} {method} {path}', flush=True)
            _t.sleep(5 * (i + 1))
    raise last

def main():
    # 1. 音频必须齐：3 节课全部 audio_id 都有 mp3
    want = set()
    for fn in ['lesson-yw1-zici.json', 'lesson-yw2-wenyan.json', 'lesson-yw3-yuedu.json']:
        d = json.load(open(os.path.join(BASE, 'content', fn)))
        for s in d['steps']:
            if s.get('audio_id'):
                want.add(s['audio_id'] + '.mp3')
    have = set(f for f in os.listdir(os.path.join(BASE, 'audio', 'yuwen')) if f.endswith('.mp3')) \
        if os.path.isdir(os.path.join(BASE, 'audio', 'yuwen')) else set()
    missing = want - have
    if missing:
        print(f'ABORT: audio/yuwen 缺 {len(missing)} 段：{sorted(missing)[:5]}...')
        return 1
    print(f'音频齐：{len(have)} 段', flush=True)
    for f in sorted(have):
        FILES.append(f'audio/yuwen/{f}')
    # 2. 取 main 最新 commit
    ref = gh('GET', f'/repos/{OWNER}/{REPO}/git/ref/heads/{BRANCH}')
    base_sha = ref['object']['sha']
    base_commit = gh('GET', f'/repos/{OWNER}/{REPO}/git/commits/{base_sha}')
    base_tree = base_commit['tree']['sha']
    print(f'base: {base_sha[:8]}', flush=True)
    # 3. 建 blob
    tree = []
    for rel in FILES:
        fp = os.path.join(BASE, rel)
        if not os.path.exists(fp):
            print(f'ABORT: 文件不存在 {rel}')
            return 1
        with open(fp, 'rb') as f:
            content = f.read()
        blob = gh('POST', f'/repos/{OWNER}/{REPO}/git/blobs',
                  {'content': base64.b64encode(content).decode(), 'encoding': 'base64'})
        tree.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
    print(f'  blobs: {len(tree)}', flush=True)
    # 4. 建 tree + commit
    new_tree = gh('POST', f'/repos/{OWNER}/{REPO}/git/trees',
                  {'base_tree': base_tree, 'tree': tree})['sha']
    msg = ('语文示范课上线：yw1 已/己/巳辨析 / yw2 记承天寺夜游 / yw3 记叙文定位法\n\n'
           '- 课程 JSON ×3（小禾文史馆剧情，七步链路，三级 HELP，承上启下）\n'
           '- 检查单红线全过：答案分布均衡、最长连续≤2，wrong_feedback 100%，禁用语零命中\n'
           '- 音频：中文 TTS 71 段（avocado_v2:MAI_01，-20 LUFS），发音未人耳验证标 UNVERIFIED\n'
           '- 注：Warm Pebble 中文实测不可懂（ASR 回转写为英文乱码），语文统一用 MAI_01')
    commit = gh('POST', f'/repos/{OWNER}/{REPO}/git/commits',
                {'message': msg, 'tree': new_tree, 'parents': [base_sha]})['sha']
    gh('PATCH', f'/repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}',
       {'sha': commit, 'force': False})
    print(f'PUSHED commit {commit[:8]} ({len(FILES)} 文件)')
    return 0

if __name__ == '__main__':
    sys.exit(main())
