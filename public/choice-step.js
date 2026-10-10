'use strict';
// choice 步骤渲染与提交（2026-10-02 总指挥补充条款：故事选择持久化）。
// - 浏览器：lesson.html 用 <script src="/choice-step.js"></script> 引入，直接用全局函数；
// - Node 测试：require 本文件，得到 { choiceStepHtml, wireChoiceStep }。
// 只用 C10 已验证写法（const/let、箭头/函数表达式、数组 map/forEach、模板/拼串、
// addEventListener、querySelectorAll、textContent、fetch、Promise、JSON）。
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// 纯函数：生成 choice 步骤的 HTML。s: {stem, scene, choice_key, options:[{label,value},...]}。
// options 只是选项标签，没有答案可泄。
function choiceStepHtml(s) {
  const opts = Array.isArray(s.options) ? s.options : [];
  const btns = opts.map(function (o) {
    // 兼容字符串选项（["心愿点播", ...]）和对象选项（[{label, value}, ...]）
    const label = (o && typeof o === 'object') ? o.label : o;
    const value = (o && typeof o === 'object') ? o.value : o;
    return '<button class="big choicebtn" data-ck="' + esc(s.choice_key) + '" data-v="' + esc(value) + '">' +
      esc(label) + '</button>';
  }).join('');
  return '<div class="card"><span class="kicker story">选你的故事</span>' +
    (s.scene ? '<div class="scene">' + esc(s.scene) + '</div>' : '') +
    '<h2 class="stem">' + esc(s.stem) + '</h2>' +
    '<div class="btnrow" id="choicerow">' + btns + '</div><div id="err"></div></div>';
}
// 绑定：点选项 -> fetch POST /api/choice 存选择 -> 成功 onDone() 进下一步，失败 onError(msg)。
// root: 步骤容器（提供 querySelectorAll）；deps: {fetchFn, lesson, onDone, onError}。
// 选择不记作答、不判分、不走 /api/attempt。
function wireChoiceStep(root, s, deps) {
  const btns = root.querySelectorAll('.choicebtn');
  btns.forEach(function (b) {
    b.addEventListener('click', function () {
      btns.forEach(function (x) { x.disabled = true; });
      deps.fetchFn('/api/choice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lesson: deps.lesson,
          key: b.getAttribute('data-ck'),
          value: b.getAttribute('data-v'),
        }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.ok) deps.onDone();
        else deps.onError('没选上，再点一次试试。');
      }).catch(function () {
        btns.forEach(function (x) { x.disabled = false; });
        deps.onError('网络有点慢，再点一次试试。');
      });
    });
  });
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { choiceStepHtml, wireChoiceStep };
}
