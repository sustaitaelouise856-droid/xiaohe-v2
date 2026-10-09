'use strict';
// Google Drive 数据库恢复：在 db.js 打开数据库之前执行
// 如果本地库为空（小于 10KB），尝试从 GDRIVE_BACKUP_URL 下载备份
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

function tryRestore() {
  const url = process.env.GDRIVE_BACKUP_URL;
  if (!url) return;
  
  const dataDir = process.env.XH_DATA_DIR || path.join(__dirname, '..', 'data');
  const dbFile = process.env.XH_DB_FILE || 'xiaohe.sqlite';
  const dbPath = path.join(dataDir, dbFile);
  
  // 检查本地库是否存在且非空
  try {
    const stat = fs.statSync(dbPath);
    if (stat.size > 10240) return; // 有数据，不覆盖
  } catch {}
  
  console.log('[gdrive] 本地库为空，尝试从 Google Drive 恢复...');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    // 用 curl 下载（同步，超时 60 秒）
    execSync(`curl -sL --max-time 60 -o "${dbPath}.tmp" "${url}"`, { stdio: 'pipe' });
    const stat = fs.statSync(dbPath + '.tmp');
    if (stat.size < 1024) {
      throw new Error('下载的文件太小，可能不是有效的数据库');
    }
    fs.renameSync(dbPath + '.tmp', dbPath);
    // 删除 WAL 文件（避免与恢复的库不一致）
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    console.log('[gdrive] 数据库恢复成功 (' + stat.size + ' bytes)');
  } catch (e) {
    console.error('[gdrive] 恢复失败:', e.message);
    try { fs.unlinkSync(dbPath + '.tmp'); } catch {}
  }
}

tryRestore();
