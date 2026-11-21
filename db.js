/* ============================================================
 * db.js — 本地持久化层（IndexedDB）
 * 所有数据只存手机本地，不上传任何服务器。
 * 存储内容：
 *   exams     研究专题
 *   messages  全量对话（永不删除，用于"记住几百天"的归档与检索）
 *   profile   核心记忆档案（AI 维护的结构化长期记忆）
 *   digests   滚动摘要（旧对话压缩后的记忆）
 *   meta      其它键值
 * ============================================================ */
const DB = (() => {
  const NAME = 'stock_ai_shell';
  const VER = 1;
  let _db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('exams'))    db.createObjectStore('exams',    { keyPath: 'id' });
        if (!db.objectStoreNames.contains('messages')) { const s = db.createObjectStore('messages', { keyPath: 'id' }); s.createIndex('examId', 'examId'); s.createIndex('ts', 'ts'); }
        if (!db.objectStoreNames.contains('profile'))  db.createObjectStore('profile',  { keyPath: 'id' });
        if (!db.objectStoreNames.contains('digests'))  { const s = db.createObjectStore('digests',  { keyPath: 'id' }); s.createIndex('examId', 'examId'); }
        if (!db.objectStoreNames.contains('meta'))     db.createObjectStore('meta',     { keyPath: 'key' });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      try { result = fn(s); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const api = {
    // ---- 通用 ----
    put(store, obj)   { return tx(store, 'readwrite', s => s.put(obj)); },
    get(store, key)   { return tx(store, 'readonly',  s => s.get(key)); },
    del(store, key)   { return tx(store, 'readwrite', s => s.delete(key)); },
    all(store)        { return tx(store, 'readonly',  s => s.getAll()); },
    clear(store)      { return tx(store, 'readwrite', s => s.clear()); },

    // ---- 按专题检索 ----
    messagesByExam(examId) {
      return open().then(db => new Promise((resolve, reject) => {
        const t = db.transaction('messages', 'readonly');
        const idx = t.objectStore('messages').index('examId');
        const req = idx.getAll(examId || '__global__');
        req.onsuccess = () => resolve(req.result.sort((a, b) => a.ts - b.ts));
        req.onerror = () => reject(req.error);
      }));
    },
    digestsByExam(examId) {
      return open().then(db => new Promise((resolve, reject) => {
        const t = db.transaction('digests', 'readonly');
        const req = t.objectStore('digests').index('examId').getAll(examId || '__global__');
        req.onsuccess = () => resolve(req.result.sort((a, b) => a.createdAt - b.createdAt));
        req.onerror = () => reject(req.error);
      }));
    },
    countMessages() { return api.all('messages').then(r => r.length); },

    // ---- meta 便捷方法 ----
    async getMeta(key, def) { const r = await api.get('meta', key); return r ? r.value : def; },
    setMeta(key, value)     { return api.put('meta', { key, value }); },

    // ---- 导入 / 导出 ----
    async exportAll() {
      const [exams, messages, profile, digests, meta] = await Promise.all([
        api.all('exams'), api.all('messages'), api.all('profile'), api.all('digests'), api.all('meta')
      ]);
      return { app: 'stock-ai-shell', version: 1, exportedAt: Date.now(), exams, messages, profile, digests, meta };
    },
    async importAll(data) {
      if (!data || data.app !== 'stock-ai-shell') throw new Error('文件格式不正确');
      for (const store of ['exams', 'messages', 'profile', 'digests', 'meta']) {
        await api.clear(store);
        for (const obj of (data[store] || [])) await api.put(store, obj);
      }
      return true;
    },
    // 合并式同步：把传入数据与本机数据按主键合并，互不覆盖。
    // messages/exams/digests/meta：同主键取时间戳较新的一条；
    // profile.main 的 facts/rules/goals：取并集去重，保证两台设备各自记的内容都不丢。
    async mergeAll(data) {
      if (!data || data.app !== 'stock-ai-shell') throw new Error('文件格式不正确');
      const keyOf = (store, o) => store === 'meta' ? o.key : o.id;
      const tsOf = o => o.updatedAt || o.createdAt || o.ts || 0;
      const stats = {};
      for (const store of ['exams', 'messages', 'digests', 'meta', 'profile']) {
        const local = await api.all(store);
        const incoming = Array.isArray(data[store]) ? data[store] : [];
        const map = new Map();
        for (const o of local) map.set(keyOf(store, o), o);
        for (const o of incoming) {
          const k = keyOf(store, o);
          if (k == null) continue;
          const prev = map.get(k);
          if (!prev || tsOf(o) >= tsOf(prev)) map.set(k, o);
        }
        // profile 的 main 记录：事实/规则/目标取并集，避免任何一边丢失
        if (store === 'profile' && map.has('main')) {
          const merged = map.get('main');
          const lp = local.find(x => x.id === 'main') || {};
          const ip = incoming.find(x => x.id === 'main') || {};
          const uniq = arr => {
            const seen = new Set(), out = [];
            for (const it of (Array.isArray(arr) ? arr : [])) {
              const key = typeof it === 'string' ? it : (it && it.text) || JSON.stringify(it);
              if (seen.has(key)) continue;
              seen.add(key); out.push(it);
            }
            return out;
          };
          merged.facts = uniq([...(lp.facts || []), ...(ip.facts || [])]);
          merged.rules = uniq([...(lp.rules || []), ...(ip.rules || [])]);
          merged.goals = uniq([...(lp.goals || []), ...(ip.goals || [])]);
          merged.summary = merged.summary || lp.summary || ip.summary || '';
          merged.updatedAt = Date.now();
        }
        await api.clear(store);
        for (const o of map.values()) await api.put(store, o);
        stats[store] = map.size;
      }
      return stats;
    }
  };
  return api;
})();
