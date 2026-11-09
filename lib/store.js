// ブラウザ内保存（IndexedDB）。動画本体は保存せず、字幕・音声・ファイルハンドルのみ。

const DB = "jimaku-studio";
let dbp;

function db() {
  return dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const d = r.result, has = n => d.objectStoreNames.contains(n);
      if (!has("jobs")) d.createObjectStore("jobs", { keyPath: "id" });
      if (!has("audio")) d.createObjectStore("audio");      // id -> {blob, energy}
      if (!has("handles")) d.createObjectStore("handles");  // id -> FileSystemFileHandle
      if (!has("frames")) d.createObjectStore("frames");    // id -> [{t, end, blob}]（画面文字用の代表フレーム）
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}

export const getJob = id => tx("jobs", "readonly", s => s.get(id));
export const putJob = job => (job.updated = Date.now(), tx("jobs", "readwrite", s => s.put(job)));
export const allJobs = async () => (await tx("jobs", "readonly", s => s.getAll())).sort((a, b) => b.created - a.created);
export const getAudio = id => tx("audio", "readonly", s => s.get(id));
export const putAudio = (id, v) => tx("audio", "readwrite", s => s.put(v, id));
export const getFrames = id => tx("frames", "readonly", s => s.get(id));
export const putFrames = (id, v) => tx("frames", "readwrite", s => s.put(v, id));
export const getHandle = id => tx("handles", "readonly", s => s.get(id));
export const putHandle = (id, h) => tx("handles", "readwrite", s => s.put(h, id));

export async function deleteJob(id) {
  await tx("jobs", "readwrite", s => s.delete(id));
  await tx("audio", "readwrite", s => s.delete(id));
  await tx("handles", "readwrite", s => s.delete(id));
  await tx("frames", "readwrite", s => s.delete(id));
}

// 設定（APIキーなど）はこの端末のlocalStorageのみに保存
export const settings = {
  get(k, d = "") { try { return localStorage.getItem("js." + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("js." + k, v); } catch { } },
};
