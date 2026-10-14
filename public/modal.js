/* 美观弹窗（2026-10-14）：替代原生 alert/confirm，样式统一 */
(function() {
  function ensureModal() {
    let ov = document.getElementById('prettyModalOv');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'prettyModalOv';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:none;align-items:center;justify-content:center;padding:24px;';
    ov.innerHTML = '<div id="prettyModalCard" style="background:#fff;border-radius:20px;padding:28px 24px;max-width:360px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.18);">'
      + '<div id="prettyModalIcon" style="font-size:44px;margin-bottom:12px;">💬</div>'
      + '<div id="prettyModalMsg" style="font-size:16px;color:#202124;line-height:1.6;margin-bottom:20px;"></div>'
      + '<div id="prettyModalBtns" style="display:flex;gap:12px;justify-content:center;"></div>'
      + '</div>';
    document.body.appendChild(ov);
    // 深色模式适配
    const darkCSS = document.createElement('style');
    darkCSS.textContent = 'html[data-theme="dark"] #prettyModalCard{background:#2d2d2d;color:#e8e8e8;}'
      + 'html[data-theme="dark"] #prettyModalMsg{color:#e8e8e8;}';
    document.head.appendChild(darkCSS);
    return ov;
  }
  function showModal(msg, opts) {
    opts = opts || {};
    return new Promise(function(resolve) {
      const ov = ensureModal();
      const icon = document.getElementById('prettyModalIcon');
      const msgEl = document.getElementById('prettyModalMsg');
      const btns = document.getElementById('prettyModalBtns');
      icon.textContent = opts.icon || '💬';
      msgEl.textContent = msg;
      btns.innerHTML = '';
      function close(val) {
        ov.style.display = 'none';
        resolve(val);
      }
      if (opts.confirm) {
        const btnCancel = document.createElement('button');
        btnCancel.textContent = opts.cancelText || '取消';
        btnCancel.style.cssText = 'flex:1;padding:12px;border-radius:12px;border:2px solid #dadce0;background:#fff;font-size:16px;font-weight:600;cursor:pointer;color:#5f6368;';
        btnCancel.onclick = function() { close(false); };
        const btnOk = document.createElement('button');
        btnOk.textContent = opts.okText || '确定';
        btnOk.style.cssText = 'flex:1;padding:12px;border-radius:12px;border:0;background:linear-gradient(135deg,#1a73e8,#4a8ef7);color:#fff;font-size:16px;font-weight:700;cursor:pointer;';
        btnOk.onclick = function() { close(true); };
        btns.appendChild(btnCancel);
        btns.appendChild(btnOk);
      } else {
        const btnOk = document.createElement('button');
        btnOk.textContent = opts.okText || '知道了';
        btnOk.style.cssText = 'padding:12px 48px;border-radius:12px;border:0;background:linear-gradient(135deg,#1a73e8,#4a8ef7);color:#fff;font-size:16px;font-weight:700;cursor:pointer;';
        btnOk.onclick = function() { close(true); };
        btns.appendChild(btnOk);
      }
      ov.style.display = 'flex';
      ov.onclick = function(e) {
        if (e.target === ov) close(opts.confirm ? false : true);
      };
    });
  }
  // 全局：美观 alert（单个按钮）
  window.prettyAlert = function(msg, icon) {
    return showModal(msg, { icon: icon });
  };
  // 全局：美观 confirm（取消/确定，返回 Promise<boolean>）
  window.prettyConfirm = function(msg, opts) {
    opts = opts || {};
    opts.confirm = true;
    return showModal(msg, opts);
  };
})();
