// 小禾英语全局主题+字体（2026-10-11）：所有页面共用，从设置页读取
// 2026-10-12 修：body 可能还不存在（script 在 <head>），等 DOM 就绪再设 zoom
(function() {
  function apply() {
    try {
      // 主题
      var th = localStorage.getItem('xh_theme');
      if (th) document.documentElement.setAttribute('data-theme', th);
      // 字体大小：用 zoom 全局缩放（0.8-1.4）
      var fz = parseFloat(localStorage.getItem('xh_font_size'));
      if (document.body && fz >= 0.8 && fz <= 1.4 && fz !== 1) {
        document.body.style.zoom = fz;
      }
      // 播放速度：供各页面读取
      window.XH_PLAY_SPEED = (function() {
        var v = parseFloat(localStorage.getItem('xh_play_speed'));
        return (v >= 0.5 && v <= 2.0) ? v : 1.0;
      })();
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();
