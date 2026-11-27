/* 小禾英语 · 进度小庆祝（fanfare 草稿 2026-11-27，未上站）
 * 只有合成音（Web Audio 振荡器），没有任何音频文件，离线 U 盘包里也能用。
 * 全部声音都短（最长 2 秒），错了的音是柔和低音，绝不用刺耳蜂鸣、不用红色、不用抖动。
 * 静音开关存在本机 localStorage（xh_sound：'0' = 关，其余 = 开，默认开）。
 * 所有声音都由他点的动作触发（提交、学完、拿称号）；首页三件做完、段位升级
 * 是页面打开时判定的，声音会等他第一次点一下页面再放，不违反自动播放规则。
 */
(function () {
  'use strict';

  var MUTE_KEY = 'xh_sound';
  var PLAN_KEY_PREFIX = 'xh_fanfare_plan_';
  var TIER_KEY = 'xh_tier_seen';
  var TIER_ORDER = ['青铜', '白银', '黄金', '铂金', '钻石', '大师', '宗师', '王者'];
  var COLORS = ['#1e8e3e', '#f2b01e', '#1a73e8', '#e8710a', '#34a853', '#ab47bc'];

  var ctx = null;

  function lsGet(k) {
    try { return window.localStorage.getItem(k); } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { window.localStorage.setItem(k, v); } catch (e) {}
  }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function isMuted() {
    return lsGet(MUTE_KEY) === '0';
  }
  function setMuted(m) {
    lsSet(MUTE_KEY, m ? '0' : '1');
  }

  function audioCtx() {
    if (ctx) return ctx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    } catch (e) {
      ctx = null;
    }
    return ctx;
  }

  /* 单个音：freq 频率，dur 秒，type 波形，gain 音量，delay 延迟秒 */
  function playTone(freq, dur, type, gain, delay) {
    if (isMuted()) return;
    var c = audioCtx();
    if (!c) return;
    try {
      if (c.state === 'suspended') c.resume();
      var t0 = c.currentTime + (delay || 0);
      var o = c.createOscillator();
      var g = c.createGain();
      o.connect(g);
      g.connect(c.destination);
      o.type = type || 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(gain || 0.16, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    } catch (e) {}
  }
  /* 一串音：list 频率数组，step 相邻间隔秒 */
  function playNotes(list, step, type, gain, dur) {
    for (var i = 0; i < list.length; i++) {
      playTone(list[i], dur || 0.45, type || 'sine', gain || 0.16, i * step);
    }
  }

  /* ---------- 视觉：彩带（样式由本模块自己注入，不依赖页面 CSS） ---------- */
  var styleDone = false;
  function ensureStyle() {
    try {
      if (styleDone || !document) return;
      if (document.getElementById('fanfare-style')) { styleDone = true; return; }
      var st = document.createElement('style');
      st.id = 'fanfare-style';
      st.textContent =
        '.fanfare-rain{position:fixed;inset:0;pointer-events:none;z-index:10000;overflow:hidden;}' +
        '.fanfare-piece{position:absolute;top:-12px;width:8px;height:12px;pointer-events:none;' +
        'animation:fanfare-fall linear forwards;}' +
        '@keyframes fanfare-fall{from{opacity:1;transform:translateY(-4px) rotate(0deg);}' +
        'to{opacity:0;transform:translateY(105vh) rotate(var(--rot,320deg));}}' +
        '.fanfare-drop-piece{position:absolute;top:0;width:7px;height:10px;pointer-events:none;' +
        'animation:fanfare-drop .9s ease-in forwards;}' +
        '@keyframes fanfare-drop{from{opacity:1;transform:translateY(-4px) rotate(0deg);}' +
        'to{opacity:0;transform:translateY(120px) rotate(var(--rot,320deg));}}' +
        '@keyframes fanfare-fadein{from{opacity:0;}to{opacity:1;}}';
      document.head.appendChild(st);
      styleDone = true;
    } catch (e) {}
  }
  function makePiece(cls) {
    var p = document.createElement('i');
    p.className = cls;
    p.style.left = (2 + Math.random() * 96) + '%';
    p.style.background = COLORS[Math.floor(Math.random() * COLORS.length)];
    p.style.setProperty('--rot', Math.floor(Math.random() * 540 - 90) + 'deg');
    p.style.animationDelay = (Math.random() * 0.15) + 's';
    return p;
  }
  /* 全屏彩带雨（盖在庆祝弹窗上，不挡点击） */
  function rain(n) {
    try {
      ensureStyle();
      var box = document.createElement('div');
      box.className = 'fanfare-rain';
      for (var i = 0; i < (n || 40); i++) {
        var p = makePiece('fanfare-piece');
        p.style.animationDuration = (1.2 + Math.random() * 0.8) + 's';
        box.appendChild(p);
      }
      document.body.appendChild(box);
      setTimeout(function () { try { box.remove(); } catch (e) {} }, 2400);
    } catch (e) {}
  }
  /* 在一块区域里撒一把彩带（首页三件做完用） */
  function burstOn(el, n) {
    try {
      if (!el) return;
      ensureStyle();
      var pos = '';
      try { pos = window.getComputedStyle ? window.getComputedStyle(el).position : ''; } catch (e) {}
      if (pos !== 'relative' && pos !== 'absolute' && pos !== 'fixed') el.style.position = 'relative';
      for (var i = 0; i < (n || 24); i++) {
        el.appendChild(makePiece('fanfare-drop-piece'));
      }
      setTimeout(function () {
        try {
          var ps = el.querySelectorAll('.fanfare-drop-piece');
          for (var j = 0; j < ps.length; j++) ps[j].remove();
        } catch (e) {}
      }, 1200);
    } catch (e) {}
  }

  /* 页面打开时判定的庆祝，声音等他第一次点页面再放（不违反自动播放规则） */
  function unlockOnGesture(fn) {
    try {
      var c = audioCtx();
      if (c && c.state === 'running') { fn(); return; }
      if (!c) return; /* 没有音频能力：画面已庆祝过，声音跳过 */
      var done = false;
      var go = function () {
        if (done) return;
        done = true;
        try { document.removeEventListener('pointerdown', go); } catch (e) {}
        try { document.removeEventListener('keydown', go); } catch (e) {}
        try { c.resume(); } catch (e) {}
        fn();
      };
      document.addEventListener('pointerdown', go);
      document.addEventListener('keydown', go);
    } catch (e) {}
  }

  /* ---------- 声音：每种进度时刻一个 ---------- */
  function correct(streak3) {
    if (streak3) playNotes([523.25, 659.25, 783.99], 0.09, 'sine', 0.16, 0.22);
    else playNotes([659.25, 880], 0.09, 'sine', 0.16, 0.22);
  }
  function wrong() {
    /* 柔和低音一个，音量小、三角波，绝不刺耳 */
    playTone(261.63, 0.4, 'triangle', 0.08, 0);
  }
  function lessonComplete() {
    playNotes([523.25, 659.25, 783.99], 0.14, 'sine', 0.18, 0.5);
  }
  function title() {
    /* 沿用 2026-10-12 已上线的称号琶音（523/659/784/1047），只改走共享模块以便静音 */
    playNotes([523, 659, 784, 1047], 0.12, 'sine', 0.25, 0.45);
  }
  function planAllDone() {
    playNotes([523.25, 659.25, 783.99, 1046.5], 0.11, 'sine', 0.18, 0.45);
  }
  function tierUp() {
    playNotes([523.25, 659.25, 783.99, 1046.5, 1318.5, 1568], 0.13, 'sine', 0.18, 0.5);
  }

  /* ---------- 首页：三件全做完，一天只庆祝一次 ---------- */
  function planAllDoneOnce(containerEl) {
    var key = PLAN_KEY_PREFIX + todayKey();
    if (lsGet(key)) return false;
    lsSet(key, '1');
    burstOn(containerEl, 24);
    unlockOnGesture(planAllDone);
    return true;
  }

  /* ---------- 首页：段位升级，只弹一次 ---------- */
  function showTierUpOverlay(name, msg) {
    try {
      var ov = document.createElement('div');
      ov.className = 'fanfare-tierup';
      ov.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.55);' +
        'display:flex;align-items:center;justify-content:center;animation:fanfare-fadein .3s ease;';
      var box = document.createElement('div');
      box.style.cssText = 'background:linear-gradient(180deg,#fff8e6,#ffedb8);border:3px solid #f2c14e;' +
        'border-radius:20px;padding:36px 48px;text-align:center;box-shadow:0 8px 32px rgba(242,193,78,.5);' +
        'max-width:86vw;';
      var icon = document.createElement('div');
      icon.textContent = '🏆';
      icon.style.cssText = 'font-size:64px;display:block;margin-bottom:12px;';
      var h = document.createElement('h2');
      h.textContent = '段位升级！';
      h.style.cssText = 'font-size:24px;color:#b54708;margin:0 0 8px;';
      var nm = document.createElement('p');
      nm.textContent = name;
      nm.style.cssText = 'font-size:32px;font-weight:900;color:#b54708;margin:0 0 8px;letter-spacing:6px;';
      var m = document.createElement('p');
      m.textContent = msg || '';
      m.style.cssText = 'font-size:15px;color:#7a4a00;margin:0 0 20px;';
      var btn = document.createElement('button');
      btn.textContent = '太棒了！';
      btn.style.cssText = 'background:linear-gradient(180deg,#ff9f2e,#e8710a);color:#fff;border:0;' +
        'border-radius:12px;padding:12px 36px;font-size:17px;font-weight:700;cursor:pointer;';
      btn.onclick = function () { try { ov.remove(); } catch (e) {} };
      box.appendChild(icon);
      box.appendChild(h);
      box.appendChild(nm);
      box.appendChild(m);
      box.appendChild(btn);
      ov.appendChild(box);
      document.body.appendChild(ov);
      rain(50);
    } catch (e) {}
  }
  function checkTierUp(tierInfo) {
    if (!tierInfo || !tierInfo.name) return false;
    var idx = TIER_ORDER.indexOf(tierInfo.name);
    if (idx < 0) return false;
    var raw = lsGet(TIER_KEY);
    var seen = raw === null ? -1 : parseInt(raw, 10);
    if (isNaN(seen)) seen = -1;
    if (seen < 0) {
      /* 第一次打开：只记下当前段位，不庆祝（他早就有的段位不算新升级） */
      lsSet(TIER_KEY, String(idx));
      return false;
    }
    if (idx > seen) {
      lsSet(TIER_KEY, String(idx));
      showTierUpOverlay(tierInfo.name, tierInfo.msg);
      unlockOnGesture(tierUp);
      return true;
    }
    return false;
  }

  /* ---------- 静音按钮 ---------- */
  function bindSoundButton(btn) {
    if (!btn) return;
    var paint = function () {
      var off = isMuted();
      btn.textContent = off ? '🔇' : '🔊';
      btn.title = off ? '音效已关，点一下打开' : '音效开着，点一下关掉';
    };
    btn.addEventListener('click', function () {
      var nowOff = !isMuted();
      setMuted(nowOff);
      paint();
      if (!nowOff) correct(false); /* 刚打开时响一声，让他知道开着 */
    });
    paint();
  }

  window.Fanfare = {
    version: '2026-11-27-draft',
    isMuted: isMuted,
    setMuted: setMuted,
    correct: correct,
    wrong: wrong,
    lessonComplete: lessonComplete,
    title: title,
    planAllDone: planAllDone,
    tierUp: tierUp,
    rain: rain,
    burstOn: burstOn,
    planAllDoneOnce: planAllDoneOnce,
    checkTierUp: checkTierUp,
    bindSoundButton: bindSoundButton
  };
})();
