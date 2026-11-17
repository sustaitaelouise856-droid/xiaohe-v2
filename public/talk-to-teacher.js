'use strict';
/* 跟老师说直连面板（2026-11-18 Elouise 批准）：课页 + 首页共用。
   孩子不用离开当前题、不用经妈妈转述，直接给老师留言。
   自动带 lesson_id / step_no / item_id / url；快捷点选 + 打字 + 30 秒语音（真存库）+ 最多 4 张图。
   文案不承诺给答案：老师只讲讲法，不直接给答案、不改分、不跳过（防作弊规则不变）。
   本文件自包含（IIFE + 自注 CSS），不声明任何顶层变量，不与各页已有脚本重名。 */
(function () {
  var CHIPS = ['这题没教过', '听不懂', '卡住了', '题目好像错了'];
  var MAX_AUDIO_SEC = 30;
  var MAX_IMGS = 4;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function injectCss() {
    if (document.getElementById('tt-style')) return;
    var st = document.createElement('style');
    st.id = 'tt-style';
    st.textContent = [
      '#tt-overlay{position:fixed;inset:0;background:rgba(32,33,36,.55);z-index:9998;display:none;align-items:flex-end;justify-content:center;}',
      '#tt-overlay.show{display:flex;}',
      '#tt-sheet{background:#fff;border-radius:20px 20px 0 0;width:100%;max-width:560px;max-height:88vh;overflow-y:auto;padding:20px 20px calc(20px + env(safe-area-inset-bottom));box-sizing:border-box;box-shadow:0 -4px 24px rgba(0,0,0,.2);}',
      '@media(min-width:640px){#tt-overlay{align-items:center;}#tt-sheet{border-radius:20px;}}',
      '#tt-sheet h2{margin:0 0 4px;font-size:19px;}',
      '#tt-ctx{font-size:13px;color:#5f6368;margin:0 0 12px;}',
      '#tt-note{font-size:13px;color:#5f6368;background:#f8f9fa;border-radius:8px;padding:8px 10px;margin:0 0 12px;line-height:1.6;}',
      '.tt-chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px;}',
      '.tt-chip{padding:9px 14px;border:2px solid #dadce0;border-radius:999px;background:#fff;font-size:15px;cursor:pointer;}',
      '.tt-chip.on{border-color:#1a73e8;background:#e8f0fe;color:#1a73e8;font-weight:700;}',
      '#tt-text{width:100%;min-height:88px;border:2px solid #dadce0;border-radius:12px;padding:12px;font-size:16px;box-sizing:border-box;font-family:inherit;resize:vertical;}',
      '#tt-text:focus{border-color:#1a73e8;outline:none;}',
      '.tt-row{margin-top:12px;}',
      '.tt-row .tt-label{font-size:14px;font-weight:700;margin-bottom:6px;}',
      '#tt-recbtn{padding:11px 18px;border:0;border-radius:999px;background:#e8710a;color:#fff;font-size:15px;font-weight:700;cursor:pointer;}',
      '#tt-recbtn.rec{background:#d93025;}',
      '#tt-recbtn:disabled{opacity:.55;cursor:default;}',
      '#tt-rectimer{font-size:14px;color:#d93025;font-weight:700;margin-left:10px;font-variant-numeric:tabular-nums;}',
      '#tt-audiobox{margin-top:8px;display:none;align-items:center;gap:8px;flex-wrap:wrap;}',
      '#tt-audiobox audio{max-width:100%;}',
      '#tt-del-audio{border:1px solid #dadce0;background:#fff;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;}',
      '#tt-imgbtn{display:inline-block;padding:9px 16px;border:1px dashed #1a73e8;border-radius:10px;color:#1a73e8;font-size:14px;font-weight:700;cursor:pointer;}',
      '#tt-previews{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;}',
      '#tt-previews img{width:76px;height:76px;object-fit:cover;border-radius:8px;border:1px solid #eee;}',
      '#tt-hint{font-size:14px;color:#5f6368;margin-top:10px;min-height:1.5em;line-height:1.6;}',
      '#tt-hint.ok{color:#137333;font-weight:700;}',
      '#tt-submit{margin-top:12px;width:100%;padding:14px;border:0;border-radius:12px;background:#1a73e8;color:#fff;font-size:16px;font-weight:700;cursor:pointer;}',
      '#tt-submit:disabled{opacity:.55;cursor:default;}',
      '#tt-close{margin-top:8px;width:100%;padding:11px;border:1px solid #dadce0;border-radius:12px;background:#fff;font-size:15px;cursor:pointer;}'
    ].join('\n');
    document.head.appendChild(st);
  }

  var els = null;         // 面板元素缓存
  var imgsB64 = [];       // 截图（最多 4 张，前端已压缩）
  var audioBlob = null;   // 语音 Blob
  var audioDurSec = 0;
  var mediaRec = null, mediaStream = null, recChunks = [], recTimer = null, recSecs = 0;

  function ctx() {
    try {
      if (typeof window.__talkTeacherContext === 'function') return window.__talkTeacherContext() || {};
    } catch (e) {}
    return {};
  }

  function ctxLine(c) {
    if (c.lesson_id && c.step_no) return '正在学：' + c.lesson_id + ' 第 ' + c.step_no + ' 题（老师能看到是哪道题，你不用再描述）';
    if (c.lesson_id) return '正在学：' + c.lesson_id + '（老师能看到是哪节课）';
    return '在首页，有什么想跟老师说的都可以写在这里。';
  }

  function build() {
    if (els) return els;
    injectCss();
    var ov = document.createElement('div');
    ov.id = 'tt-overlay';
    ov.innerHTML =
      '<div id="tt-sheet" role="dialog" aria-label="跟老师说">' +
      '<h2>💬 跟老师说</h2>' +
      '<p id="tt-ctx"></p>' +
      '<p id="tt-note">老师会讲给你听，帮你想明白，不会直接给答案；要答案、改分、跳过，老师不会答应哦。</p>' +
      '<div class="tt-chips" id="tt-chips"></div>' +
      '<textarea id="tt-text" placeholder="写给老师的话，比如：这题我没学过，不知道从哪想…"></textarea>' +
      '<div class="tt-row"><div class="tt-label">🎤 语音（30 秒以内，可不录）</div>' +
      '<div id="tt-recrow"><button type="button" id="tt-recbtn">🎤 开始录音</button><span id="tt-rectimer"></span></div>' +
      '<div id="tt-recnote" style="font-size:13px;color:#5f6368;margin-top:6px;"></div>' +
      '<div id="tt-audiobox"><audio id="tt-player" controls></audio><button type="button" id="tt-del-audio">🗑 重录</button></div></div>' +
      '<div class="tt-row"><div class="tt-label">📷 截图（最多 4 张，可不加）</div>' +
      '<label id="tt-imgbtn" for="tt-img">📷 加截图</label>' +
      '<input type="file" id="tt-img" accept="image/*" multiple style="display:none;">' +
      '<span id="tt-imgname" style="font-size:13px;color:#5f6368;margin-left:8px;"></span>' +
      '<div id="tt-previews"></div></div>' +
      '<div id="tt-hint"></div>' +
      '<button type="button" id="tt-submit">发送给老师</button>' +
      '<button type="button" id="tt-close">先不说了</button>' +
      '</div>';
    ov.addEventListener('click', function (ev) { if (ev.target === ov) close(); });
    document.body.appendChild(ov);

    var chipsBox = ov.querySelector('#tt-chips');
    CHIPS.forEach(function (phrase) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tt-chip';
      b.textContent = phrase;
      b.addEventListener('click', function () {
        var ta = ov.querySelector('#tt-text');
        var lines = ta.value.split('\n').map(function (s) { return s.trim(); });
        var i = lines.indexOf(phrase);
        if (i >= 0) { lines.splice(i, 1); b.classList.remove('on'); }
        else { lines.push(phrase); b.classList.add('on'); }
        ta.value = lines.filter(function (s) { return s; }).join('\n');
        ta.focus();
      });
      chipsBox.appendChild(b);
    });

    ov.querySelector('#tt-recbtn').addEventListener('click', toggleRec);
    ov.querySelector('#tt-del-audio').addEventListener('click', clearAudio);
    ov.querySelector('#tt-img').addEventListener('change', onImgPick);
    ov.querySelector('#tt-submit').addEventListener('click', submit);
    ov.querySelector('#tt-close').addEventListener('click', close);

    els = { ov: ov, ctx: ov.querySelector('#tt-ctx'), text: ov.querySelector('#tt-text'),
      hint: ov.querySelector('#tt-hint'), submit: ov.querySelector('#tt-submit'),
      recbtn: ov.querySelector('#tt-recbtn'), rectimer: ov.querySelector('#tt-rectimer'),
      recnote: ov.querySelector('#tt-recnote'), audiobox: ov.querySelector('#tt-audiobox'),
      player: ov.querySelector('#tt-player'), previews: ov.querySelector('#tt-previews'),
      imgname: ov.querySelector('#tt-imgname') };
    return els;
  }

  function reset() {
    imgsB64 = [];
    clearAudio();
    if (!els) return;
    els.text.value = '';
    els.hint.textContent = '';
    els.hint.className = '';
    els.submit.disabled = false;
    els.submit.textContent = '发送给老师';
    els.previews.innerHTML = '';
    els.imgname.textContent = '';
    Array.prototype.forEach.call(els.ov.querySelectorAll('.tt-chip'), function (c) { c.classList.remove('on'); });
  }

  function open() {
    var e = build();
    e.ctx.textContent = ctxLine(ctx());
    e.ov.classList.add('show');
    setTimeout(function () { e.text.focus(); }, 50);
  }

  function close() {
    stopRec(true);
    if (els) els.ov.classList.remove('show');
  }

  /* ---- 语音：MediaRecorder，30 秒自动停；不支援的浏览器只留打字 ---- */
  function recSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }
  function fmtSecs(s) { return '0:' + (s < 10 ? '0' : '') + s + ' / 0:30'; }
  async function toggleRec() {
    if (mediaRec && mediaRec.state === 'recording') { stopRec(false); return; }
    if (!recSupported()) { els.recnote.textContent = '这个浏览器不能录音，可以打字告诉老师。'; return; }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      els.recnote.textContent = '录音没打开权限，可以打字告诉老师。';
      return;
    }
    recChunks = [];
    try { mediaRec = new MediaRecorder(mediaStream); }
    catch (e) { els.recnote.textContent = '这个浏览器不能录音，可以打字告诉老师。'; return; }
    mediaRec.ondataavailable = function (ev) { if (ev.data && ev.data.size) recChunks.push(ev.data); };
    mediaRec.onstop = function () {
      if (mediaStream) { mediaStream.getTracks().forEach(function (tr) { tr.stop(); }); mediaStream = null; }
      var blob = new Blob(recChunks, { type: (mediaRec && mediaRec.mimeType) || 'audio/webm' });
      if (blob.size > 0) {
        audioBlob = blob;
        audioDurSec = recSecs;
        els.player.src = URL.createObjectURL(blob);
        els.audiobox.style.display = 'flex';
        els.recnote.textContent = '录好了，可以先听一遍再发。';
      }
      els.recbtn.textContent = '🎤 重新录音';
      els.recbtn.classList.remove('rec');
      els.rectimer.textContent = '';
    };
    recSecs = 0;
    els.rectimer.textContent = fmtSecs(0);
    els.recbtn.textContent = '■ 停止';
    els.recbtn.classList.add('rec');
    els.recnote.textContent = '正在录音…最多 30 秒。';
    mediaRec.start(250);
    recTimer = setInterval(function () {
      recSecs++;
      els.rectimer.textContent = fmtSecs(Math.min(recSecs, MAX_AUDIO_SEC));
      if (recSecs >= MAX_AUDIO_SEC) stopRec(false);
    }, 1000);
  }
  function stopRec(silent) {
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
    if (mediaRec && mediaRec.state === 'recording') { try { mediaRec.stop(); } catch (e) {} }
    else if (mediaStream) { mediaStream.getTracks().forEach(function (tr) { tr.stop(); }); mediaStream = null; }
    if (!silent && els) { els.recbtn.classList.remove('rec'); }
  }
  function clearAudio() {
    stopRec(true);
    audioBlob = null;
    audioDurSec = 0;
    if (!els) return;
    try { if (els.player.src) URL.revokeObjectURL(els.player.src); } catch (e) {}
    els.player.removeAttribute('src');
    els.audiobox.style.display = 'none';
    els.recbtn.textContent = '🎤 开始录音';
    els.recbtn.classList.remove('rec');
    els.rectimer.textContent = '';
    els.recnote.textContent = '';
  }

  /* ---- 截图：沿用设置页做法，前端压缩到宽 1000、JPEG 0.7，最多 4 张 ---- */
  function renderPreviews() {
    if (!els) return;
    els.previews.innerHTML = '';
    imgsB64.forEach(function (b64, i) {
      var w = document.createElement('div');
      w.style.cssText = 'position:relative;display:inline-block;';
      var im = document.createElement('img');
      im.src = b64;
      var x = document.createElement('button');
      x.type = 'button'; x.textContent = '×';
      x.style.cssText = 'position:absolute;top:-7px;right:-7px;width:21px;height:21px;border-radius:50%;border:0;background:#d93025;color:#fff;font-size:14px;line-height:21px;text-align:center;cursor:pointer;padding:0;';
      x.addEventListener('click', function () { imgsB64.splice(i, 1); renderPreviews(); updateImgName(); });
      w.appendChild(im); w.appendChild(x); els.previews.appendChild(w);
    });
  }
  function updateImgName() {
    if (els) els.imgname.textContent = imgsB64.length ? ('已添加 ' + imgsB64.length + ' 张（最多4张）') : '';
  }
  function onImgPick(ev) {
    var input = ev.target;
    var files = Array.prototype.slice.call(input.files || []);
    input.value = '';
    if (!files.length) return;
    var room = MAX_IMGS - imgsB64.length;
    if (room <= 0) { els.imgname.textContent = '最多4张，已经满了'; return; }
    var todo = files.slice(0, room);
    var pending = todo.length;
    els.imgname.textContent = '压缩中…';
    todo.forEach(function (f) {
      var img = new Image();
      img.onload = function () {
        try {
          var sc = Math.min(1, 1000 / img.width);
          var c = document.createElement('canvas');
          c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          if (imgsB64.length < MAX_IMGS) { imgsB64.push(c.toDataURL('image/jpeg', 0.7)); renderPreviews(); }
        } catch (e) {}
        URL.revokeObjectURL(img.src);
        if (--pending <= 0) updateImgName();
      };
      img.onerror = function () { URL.revokeObjectURL(img.src); if (--pending <= 0) updateImgName(); };
      img.src = URL.createObjectURL(f);
    });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  async function submit() {
    var e = els;
    var text = e.text.value.trim();
    if (!text && !imgsB64.length && !audioBlob) {
      e.hint.textContent = '写点文字、录句话或加张截图吧。';
      return;
    }
    e.submit.disabled = true;
    e.submit.textContent = '发送中…';
    e.hint.textContent = '';
    e.hint.className = '';
    try {
      var c = ctx();
      var body = { text: text, image_b64: imgsB64[0] || '', images_b64: imgsB64,
        lesson_id: c.lesson_id || '', step_no: c.step_no || null, item_id: c.item_id || '',
        url: location.href };
      if (audioBlob) {
        body.audio_b64 = await blobToDataUrl(audioBlob);
        body.audio_mime = audioBlob.type || 'audio/webm';
        body.audio_duration_sec = audioDurSec;
      }
      var r = await fetch('/api/feedback', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      var d = await r.json().catch(function () { return {}; });
      if (d && d.ok) {
        e.hint.textContent = '✅ 老师看到了！卡住了先点“老师教我”看一级提示，继续往下做。';
        e.hint.className = 'ok';
        var keepId = d.id;
        setTimeout(function () { reset(); close(); }, 2600);
      } else if (d && d.error === 'audio_too_large') {
        e.hint.textContent = '语音太大了，重录一段短一点的再发。';
        e.submit.disabled = false;
        e.submit.textContent = '发送给老师';
      } else {
        e.hint.textContent = '发送失败，再点一次试试。';
        e.submit.disabled = false;
        e.submit.textContent = '发送给老师';
      }
    } catch (err) {
      e.hint.textContent = '网络不好，稍后再试。';
      e.submit.disabled = false;
      e.submit.textContent = '发送给老师';
    }
  }

  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-talk-teacher]'), function (btn) {
      btn.addEventListener('click', open);
    });
    if (!recSupported()) {
      /* 录音按钮先留着，点开面板时再提示（避免首页直接吓到孩子） */
    }
  }

  window.TalkTeacher = { open: open, close: close };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
