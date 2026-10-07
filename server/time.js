'use strict';
// 全站时间统一按 Asia/Shanghai（北京时间）计算，不依赖服务器本地时区。
// 背景（2026-09-30 Elouise 意见二1）：家里电脑是太平洋时间，
// 两天制、备份文件名、日志时间都必须按北京时间，不能跟着服务器本地时间走。

// 上海自然日 YYYY-MM-DD（两天制"第二天开放"判断用）
function shanghaiDay(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d || new Date());
}

// 上海时间戳 'YYYY-MM-DD HH:MM:SS'（日志、备份文件名用）
function shanghaiTimestamp(d) {
  return (d || new Date()).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

module.exports = { shanghaiDay, shanghaiTimestamp };
