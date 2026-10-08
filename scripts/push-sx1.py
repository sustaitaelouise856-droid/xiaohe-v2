#!/usr/bin/env python3
"""推送数学课上线文件到 GitHub（sustaitaelouise856-droid/xiaohe-v2 main）。
用 Git Trees API 一次提交（文件多，Contents API 逐个太慢）。
认证：Elouise 的 GitHub PAT（custom.github-pat），经 dynamic_credentials.py。
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
    # 课程
    'content/lesson-sx1.json',
    'content/lesson-sx2.json',
    'content/lesson-sx3.json',
    # 服务端：数学判分 + autoSeed 入库
    'server/grade.js',
    'server/seed.js',
    # 前端：KaTeX 按需加载 + 公式渲染 + 数据驱动 kicker
    'public/lesson.html',
    # 测试
    'tests/grade.test.js',
    # 文档
    'docs/SHUXUE-KICKOFF.md',
    'docs/SHUXUE-MASTER.md',
    'docs/SHUXUE-TASKLIST.md',
    # 音频生成脚本（可追溯）
    'scripts/gen-audio-sx.py',
    'scripts/gen-audio-sx1.py',
    'scripts/push-sx1.py',
]
# KaTeX 自托管 + 数学音频：目录批量加入
for root, _, files in os.walk(os.path.join(BASE, 'public/vendor/katex')):
    for f in sorted(files):
        FILES.append(os.path.relpath(os.path.join(root, f), BASE))
for lid in ['sx1', 'sx2', 'sx3']:
    d = os.path.join(BASE, 'audio', lid)
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            if f.endswith('.mp3'):
                FILES.append(os.path.relpath(os.path.join(d, f), BASE))

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
    # 1. 音频必须齐：每课 7 段 teach 音频
    for lid in ['sx1', 'sx2', 'sx3']:
        d = os.path.join(BASE, 'audio', lid)
        n = len([f for f in os.listdir(d) if f.endswith('.mp3')]) if os.path.isdir(d) else 0
        if n < 7:
            print(f'ABORT: audio/{lid} 只有 {n} 段音频（要 7 段），先跑完 scripts/gen-audio-sx.py')
            return 1
    # 2. 取 main 最新 commit
    ref = gh('GET', f'/repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}')
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
        # 大文件（>900KB）GitHub blob API 也支持，但这里都小于 1MB，直接推
        blob = gh('POST', f'/repos/{OWNER}/{REPO}/git/blobs',
                  {'content': base64.b64encode(content).decode(), 'encoding': 'base64'})
        tree.append({'path': rel, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
        print(f'  blob {rel} ({len(content)//1024}KB)', flush=True)
    # 4. 建 tree + commit
    print('建 tree...', flush=True)
    new_tree = gh('POST', f'/repos/{OWNER}/{REPO}/git/trees',
                  {'base_tree': base_tree, 'tree': tree})['sha']
    print('建 commit...', flush=True)
    msg = ('数学课上线：sx1 因式分解·提公因式法 / sx2 完全平方公式 / sx3 平方差公式\n\n'
           '- 课程 JSON ×3（侦探解方程剧情，七步链路，三级 HELP）\n'
           '- 公式显示：KaTeX 自托管（public/vendor/katex），lesson.html 按需加载\n'
           '- 判分：server/grade.js 新增 type:math 等价形式判分\n'
           '- 入库：server/seed.js autoSeed 支持 sx（draft 状态，不进英语首页序列）\n'
           '- 音频：中文 TTS 21 段（Warm Pebble，-20 LUFS），未人耳验证标 UNVERIFIED')
    commit = gh('POST', f'/repos/{OWNER}/{REPO}/git/commits',
                {'message': msg, 'tree': new_tree, 'parents': [base_sha]})['sha']
    gh('PATCH', f'/repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}',
       {'sha': commit, 'force': False})
    print(f'PUSHED commit {commit[:8]} ({len(FILES)} 文件)')
    return 0

if __name__ == '__main__':
    sys.exit(main())
