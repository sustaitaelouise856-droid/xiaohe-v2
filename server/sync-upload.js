'use strict';
// sync-upload.js — POST /api/admin/sync-upload：接收 U 盘离线库文件，
// 按行合并回主站库。只做合并，不做整库覆盖；合并逻辑在 sync-merge.js。
//
// 认证：与 /api/admin/backup 同一个 BACKUP_TOKEN（query token 或
// x-backup-token 头）。没带对口令返回 403。
//
// 接入方法（由 apply-merge-endpoint.py 自动加）：
//   在 server/index.js 里 `const app = express();` 之后加一行：
//   require('./sync-upload')(app, db);
//
// 请求：POST，Content-Type: application/octet-stream，body 就是整个
// xiaohe.sqlite 文件（约 3MB，上限 10MB）。
// 响应：{ ok: true, merged: { inserted: {...}, updated: {...} } }

const express = require('express');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { mergeOfflineDb } = require('./sync-merge');

module.exports = function registerSyncUpload(app, db) {
  app.post('/api/admin/sync-upload',
    express.raw({ type: 'application/octet-stream', limit: '10mb' }),
    (req, res) => {
      const token = req.query.token || req.headers['x-backup-token'];
      if (!process.env.BACKUP_TOKEN || token !== process.env.BACKUP_TOKEN) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
      }
      if (!req.body || !Buffer.isBuffer(req.body) || req.body.length < 1024) {
        return res.status(400).json({ ok: false, error: 'empty_body' });
      }
      if (req.body.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') {
        return res.status(400).json({ ok: false, error: 'not_sqlite' });
      }
      const dataDir = process.env.XH_DATA_DIR || path.join(__dirname, '..', 'data');
      const tmpPath = path.join(dataDir, 'sync-upload-' + Date.now() + '.sqlite');
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(tmpPath, req.body);
        const up = new DatabaseSync(tmpPath, { readOnly: true });
        let stats;
        try {
          stats = mergeOfflineDb(db, up);
        } finally {
          up.close();
        }
        console.log('[sync-upload] merged:', JSON.stringify(stats));
        return res.json({ ok: true, merged: stats });
      } catch (e) {
        console.error('[sync-upload] failed:', e.message);
        return res.status(400).json({ ok: false, error: e.message });
      } finally {
        try { fs.unlinkSync(tmpPath); } catch (ignored) {}
        try { fs.unlinkSync(tmpPath + '-shm'); } catch (ignored) {}
        try { fs.unlinkSync(tmpPath + '-wal'); } catch (ignored) {}
      }
    });
};
