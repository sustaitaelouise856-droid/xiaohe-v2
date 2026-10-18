#!/usr/bin/env python3
"""标准推送脚本（2026-10-11）：推送前强制跑发版检查单，红线不过直接阻断，一个文件都不会推出去。

用法（在 ~/workspace/xiaohe-deploy 下执行）：
    python3 scripts/push.py -m "提交信息" <本地路径>:<仓库路径> [<本地路径>:<仓库路径> ...]

示例：
    python3 scripts/push.py -m "修复 u2r4 再想想" content/lesson-u2r4.json:content/lesson-u2r4.json

- 本地路径可为相对路径（相对仓库根）或绝对路径。
- 先跑 scripts/pre-deploy-check.py（--base-dir 指本仓库）；红线失败则直接退出，不推送任何文件。
- 推送成功后自动触发 Render 重新部署。
"""
import sys, os, json, base64, argparse, subprocess, urllib.request, urllib.error, re

sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_URL = 'https://xiaohe-v2-1.onrender.com'  # 2026-10-18：推送前查活跃度用
OWNER = 'sustaitaelouise856-droid'
REPO = 'xiaohe-v2'
RENDER_DEPLOY_URL = 'https://api.render.com/v1/services/srv-db2sq149v7es73a52qvg/deploys'
CHECK_SCRIPT = '/home/hatch/workspace/xiaohe-v2/scripts/pre-deploy-check.py'


def gh(method, path, data=None):
    url = 'https://api.github.com' + path
    req = urllib.request.Request(url, method=method)
    req.add_header('Accept', 'application/vnd.github.v3+json')
    req.add_header('User-Agent', 'Muse-Push')
    add_surrogate_to_request(req, 'custom.github-pat', allowed_hosts=['api.github.com'])
    if data is not None:
        req.data = json.dumps(data).encode()
        req.add_header('Content-Type', 'application/json')
    resp = urllib.request.urlopen(req, timeout=60)
    return read_json_response(resp)


def run_check(pairs):
    print('=== 步骤 1/3：强制发版检查（红线不过，禁止推送） ===', flush=True)
    # 音频红线只对本次推送涉及的课程生效：修 UI/服务端时不因无关课程的音频缺失而被拦；
    # 但只要推了某节课的 JSON，它缺音频就一定推不上去（Elouise 的红线原意）。
    touched = set()
    for _, remote in pairs:
        m = re.match(r'content/lesson-([A-Za-z0-9_-]+)\.json$', remote)
        if m:
            touched.add(m.group(1))
    cmd = [sys.executable, CHECK_SCRIPT, '--base-dir', BASE,
           '--audio-lessons', ','.join(sorted(touched))]
    r = subprocess.run(cmd)
    if r.returncode != 0:
        print('\n🛑 检查单红线未通过，推送已阻断：一个文件都没有推出去。', flush=True)
        print('   请先修复上面的红线项，再重新执行本脚本。', flush=True)
        return False
    print('✅ 检查单通过，继续推送。', flush=True)
    # 2026-10-17：新增三个关键流程自动化测试（Elouise 定）
    for script in ['verify-retest-loop.js', 'verify-unlock-gate.js', 'verify-titles.js']:
        sp = os.path.join(BASE, 'scripts', script)
        if os.path.exists(sp):
            print(f'--- 跑 {script} ---', flush=True)
            r2 = subprocess.run(['node', sp], cwd=BASE)
            if r2.returncode != 0:
                print(f'\n🛑 {script} 未通过，推送已阻断。', flush=True)
                return False
            print(f'✅ {script} 通过。', flush=True)
    return True


def push_files(pairs, message):
    print('=== 步骤 2/3：推送 %d 个文件到 GitHub ===' % len(pairs), flush=True)
    for local, remote in pairs:
        if not os.path.isfile(local):
            print('  ✖ 本地文件不存在：%s（本次推送全部取消）' % local, flush=True)
            return False
    for local, remote in pairs:
        with open(local, 'rb') as f:
            content_b64 = base64.b64encode(f.read()).decode()
        try:
            info = gh('GET', '/repos/%s/%s/contents/%s?ref=main' % (OWNER, REPO, remote))
            sha = info.get('sha')
        except urllib.error.HTTPError as e:
            if e.code == 404:
                sha = None  # 新文件
            else:
                raise
        payload = {'message': message, 'content': content_b64, 'branch': 'main'}
        if sha:
            payload['sha'] = sha
        gh('PUT', '/repos/%s/%s/contents/%s' % (OWNER, REPO, remote), payload)
        print('  ✓ %s' % remote, flush=True)
    return True


def trigger_deploy():
    print('=== 步骤 3/3：触发 Render 重新部署 ===', flush=True)
    req = urllib.request.Request(RENDER_DEPLOY_URL, method='POST')
    req.data = json.dumps({}).encode()
    req.add_header('Content-Type', 'application/json')
    add_surrogate_to_request(req, 'custom.render', allowed_hosts=['api.render.com'])
    resp = urllib.request.urlopen(req, timeout=30)
    data = read_json_response(resp)
    print('Render deploy 已触发：%s' % data.get('deploy', {}).get('id', 'unknown'), flush=True)


def main():
    ap = argparse.ArgumentParser(description='发版检查门禁 + GitHub 推送 + Render 部署')
    ap.add_argument('-m', '--message', required=True, help='提交信息')
    ap.add_argument('files', nargs='+', help='<本地路径>:<仓库路径>')
    ap.add_argument('--during-study', action='store_true',
                    help='孩子正在学习时仍推送（Elouise 明确要求"现在推"时才用）')
    args = ap.parse_args()

    # 2026-10-18 学习时段保护：孩子近15分钟有作答 → 推送会重启服务打断学习，默认阻断
    if not args.during_study:
        try:
            import urllib.request, json as _json, datetime as _dt
            with urllib.request.urlopen(SITE_URL + '/api/activity', timeout=15) as r:
                act = _json.load(r)
            last = act.get('last_attempt')
            if last:
                dt = _dt.datetime.strptime(last[:19], '%Y-%m-%d %H:%M:%S')
                mins = (_dt.datetime.utcnow() - dt).total_seconds() / 60
                if mins < 15:
                    print('⛔ 阻断：孩子正在学习（%d 分钟前有作答），推送会重启服务打断。' % int(mins), flush=True)
                    print('   非紧急请等他学完再推；紧急修复经 Elouise 明确要求后加 --during-study 重推。', flush=True)
                    return 1
        except SystemExit:
            raise
        except Exception as e:
            print('（活跃度检查失败，继续推送：%s）' % e, flush=True)

    pairs = []
    for item in args.files:
        if ':' not in item:
            ap.error('文件参数格式应为 <本地路径>:<仓库路径>， got: %s' % item)
        local, remote = item.split(':', 1)
        if not os.path.isabs(local):
            local = os.path.join(BASE, local)
        pairs.append((local, remote))

    if not run_check(pairs):
        return 1
    if not push_files(pairs, args.message):
        return 1
    try:
        trigger_deploy()
    except Exception as e:
        print('Render 触发失败（文件已推送）：%s' % e, flush=True)
        return 2
    print('\n全部完成：检查通过 → 已推送 → 部署已触发。', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
