/*
 * Local stand-in for the Claude artifact runtime.
 * Provides window.claude.use('user') and window.claude.use('db') with the same
 * calls the app already makes, backed by the Node server's /api routes.
 * Live updates (onSnapshot) are implemented by light polling.
 */
(function () {
  const UID_KEY = 'javacur.uid';
  const POLL_MS = 1500;
  const watchers = new Set(); // active onSnapshot tick functions
  const pollNow = () => watchers.forEach((t) => t());

  async function api(path, opts) {
    const r = await fetch('/api/' + path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.code = j.code || 'http-' + r.status; throw e; }
    return j;
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(12))).map((b) => b.toString(16).padStart(2, '0')).join('');

  function getUid() { try { let v = localStorage.getItem(UID_KEY); if (!v) { v = 'anon-' + rand(); localStorage.setItem(UID_KEY, v); } return v; } catch (e) { return 'anon-session'; } }
  let uid = getUid();

  const userCap = {
    id: async () => uid,
    setId: (id) => { uid = id; try { localStorage.setItem(UID_KEY, id); } catch (e) {} },
    idForEmail: async (email) => (await post('idForEmail', { email })).id,
    isOwner: async () => (await api('role?id=' + encodeURIComponent(uid))).role === 'owner',
    canEdit: async () => ['owner', 'superadmin', 'admin'].includes((await api('role?id=' + encodeURIComponent(uid))).role),
  };

  const docSnap = (id, res) => ({ id, exists: !!res.exists, data: () => (res.exists ? res.data : undefined) });
  function docRef(path) {
    const id = path.split('/').pop();
    return {
      id, path,
      get: async () => docSnap(id, await api('doc?path=' + encodeURIComponent(path))),
      set: async (data) => { await post('doc?path=' + encodeURIComponent(path), { op: 'set', data }); pollNow(); },
      update: async (data) => { await post('doc?path=' + encodeURIComponent(path), { op: 'update', data }); pollNow(); },
      delete: async () => { await post('doc?path=' + encodeURIComponent(path), { op: 'delete' }); pollNow(); },
    };
  }
  function query(name, q) {
    const clone = (patch) => query(name, Object.assign({}, q, patch));
    const run = async () => {
      const r = await post('collection', { name, orderBy: q.orderBy, limit: q.limit });
      const docs = r.docs.map((d) => ({ id: d.id, exists: true, data: () => d.data }));
      return { size: docs.length, empty: !docs.length, docs, _sig: JSON.stringify(r.docs) };
    };
    return {
      limit: (n) => clone({ limit: n }),
      orderBy: (field, dir) => clone({ orderBy: { field, dir: dir || 'asc' } }),
      get: run,
      onSnapshot(cb, errCb) {
        let stopped = false, last = null, timer = null, busy = false;
        const tick = async () => {
          if (stopped || busy) return;
          busy = true; clearTimeout(timer);
          try { const snap = await run(); if (snap._sig !== last) { last = snap._sig; cb(snap); } }
          catch (e) { if (errCb) errCb(e); }
          busy = false;
          if (!stopped) timer = setTimeout(tick, POLL_MS);
        };
        watchers.add(tick); tick();
        return () => { stopped = true; clearTimeout(timer); watchers.delete(tick); };
      },
    };
  }
  const dbCap = {
    doc: docRef,
    collection: (name) => Object.assign(query(name, {}), {
      add: async (data) => { const r = await post('collection', { name, op: 'add', data }); pollNow(); return docRef(name + '/' + r.id); },
      doc: (id) => docRef(name + '/' + id),
    }),
  };

  window.claude = { use: async (name) => { if (name === 'user') return userCap; if (name === 'db') return dbCap; throw new Error('Unknown capability: ' + name); } };
})();
