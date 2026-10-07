/* 客户端错误上报（2026-10-03 k包）
 * 用法：在页面 <head> 尽早引入：<script src="/client-error.js"></script>
 * 功能：
 * 1. window.onerror / unhandledrejection 自动上报到 /api/client-error（带 UA、URL、堆栈）
 * 2. 提供 window.__reportInitFailure(msg)：页面初始化失败时调用，
 *    在 #content 或 body 显示"重新加载本题"按钮，不是一个点不动的空壳
 * 兼容性：只用 ES5 语法，确保老内核也能跑这段代码
 */
(function() {
  var REPORT_URL = '/api/client-error';
  var queue = [];
  var sending = false;

  function sendBatch() {
    if (sending || !queue.length) return;
    sending = true;
    var batch = queue.splice(0, queue.length);
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', REPORT_URL, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onreadystatechange = function() {
        if (xhr.readyState === 4) { sending = false; if (queue.length) sendBatch(); }
      };
      // 只发第一条，避免刷屏；带上 UA 和页面 URL
      var e = batch[0];
      xhr.send(JSON.stringify({
        message: e.message, source: e.source, lineno: e.lineno, colno: e.colno,
        stack: e.stack, url: location.href,
        user_agent: navigator.userAgent
      }));
    } catch (err) { sending = false; }
  }

  function report(message, source, lineno, colno, stack) {
    // 去重：同一消息 5 秒内只报一次
    var now = Date.now();
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].message === message && now - queue[i].t < 5000) return;
    }
    queue.push({ message: String(message).slice(0, 2000), source: source, lineno: lineno, colno: colno, stack: stack, t: now });
    // 限制队列长度
    if (queue.length > 10) queue.shift();
    sendBatch();
  }

  window.addEventListener('error', function(ev) {
    report(ev.message || 'Script error', ev.filename || '', ev.lineno || 0, ev.colno || 0,
           (ev.error && ev.error.stack) || '');
  });
  window.addEventListener('unhandledrejection', function(ev) {
    var r = ev.reason;
    report('Unhandled rejection: ' + (r && r.message ? r.message : String(r)), '', 0, 0,
           (r && r.stack) || '');
  });

  // 页面初始化失败时的兜底：显示"重新加载本题"按钮
  window.__reportInitFailure = function(msg) {
    report('Init failure: ' + msg, location.href, 0, 0, '');
    var host = document.getElementById('content') || document.getElementById('wrap') || document.body;
    var div = document.createElement('div');
    div.style.cssText = 'max-width:600px;margin:80px auto;padding:32px;text-align:center;background:#fff;border:1px solid #dadce0;border-radius:16px;font-family:sans-serif;';
    div.innerHTML = '<p style="font-size:22px;margin-bottom:16px;">页面加载出了点问题</p>' +
      '<button onclick="location.reload()" style="font-size:22px;padding:14px 40px;background:#1a73e8;color:#fff;border:0;border-radius:12px;cursor:pointer;">重新加载本题</button>';
    // 清空原有内容，避免空壳
    host.innerHTML = '';
    host.appendChild(div);
  };

  // 暴露手动上报接口
  window.__reportError = report;

  // k包：关键 API 缺失时的早期预警（C10 兼容）
  // 如果 fetch/Promise 不存在，后续所有逻辑都会失败，直接显示重载按钮
  window.__checkCompat = function() {
    var missing = [];
    if (typeof fetch === 'undefined') missing.push('fetch');
    if (typeof Promise === 'undefined') missing.push('Promise');
    if (typeof JSON === 'undefined' || !JSON.parse) missing.push('JSON');
    if (missing.length) {
      report('Missing APIs: ' + missing.join(','), location.href, 0, 0, navigator.userAgent);
      return false;
    }
    return true;
  };
})();
