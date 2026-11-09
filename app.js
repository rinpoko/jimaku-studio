import * as store from "./lib/store.js";
import { probe, extractAudio, extractKeyframes, refineScreenTimes, sliceAudio, planChunks, refineTimes, tidy, burn } from "./lib/media.js";
import { listModels, pickDefaultModel, transcribeChunk, readScreen, GeminiError } from "./lib/gemini.js";
import { fmtClock, fmtDur, cueText, cueAt, toSRTAll, toVTTAll, screenPlacement, bottomBusy } from "./lib/subs.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LANGS = { en: "英語", ja: "日本語", zh: "中国語", ko: "韓国語", es: "スペイン語", fr: "フランス語", de: "ドイツ語", it: "イタリア語", pt: "ポルトガル語", ru: "ロシア語", th: "タイ語", vi: "ベトナム語", id: "インドネシア語" };
const S = store.settings;
const RUNNING_STATES = ["queued", "audio", "transcribe", "waiting"];

const files = new Map();     // jobId -> File（このセッション中に選ばれた動画）
const running = new Map();   // jobId -> {stop:boolean}
let wakeLock = null;

/* ======================= 環境チェック ======================= */
const supported = "VideoDecoder" in window && "AudioEncoder" in window && "OffscreenCanvas" in window;

/* ======================= 設定ダイアログ ======================= */
const dlg = $("#settings");
let modelsCache = null;

function fillModelSelect(models, current) {
  const sel = $("#s-model");
  const list = models?.length ? models : [{ id: current || "gemini-3.5-flash-lite", label: current || "gemini-3.5-flash-lite" }];
  sel.innerHTML = list.map(m => `<option value="${esc(m.id)}">${esc(m.label)}（${esc(m.id)}）</option>`).join("");
  sel.value = list.some(m => m.id === current) ? current : pickDefaultModel(list);
}

async function checkKey() {
  const key = $("#s-key").value.trim();
  const msg = $("#s-check-msg");
  if (!key) { msg.className = "small err-msg"; msg.textContent = "APIキーを入力してください"; return false; }
  msg.className = "small muted"; msg.textContent = "確認中…";
  try {
    modelsCache = await listModels(key);
    fillModelSelect(modelsCache, $("#s-model").value || S.get("model"));
    msg.className = "small ok-msg"; msg.textContent = `✓ 使えます（音声に対応したモデル ${modelsCache.length}件）`;
    return true;
  } catch (e) {
    msg.className = "small err-msg"; msg.textContent = e.message;
    return false;
  }
}

function openSettings() {
  $("#s-key").value = S.get("apiKey");
  $("#s-lang").value = S.get("lang", "auto");
  $("#s-chunk").value = S.get("chunk", "300");
  $("#s-screen").checked = S.get("screen", "1") === "1";
  fillModelSelect(modelsCache, S.get("model"));
  $("#s-check-msg").textContent = "";
  dlg.showModal();
  if (S.get("apiKey") && !modelsCache) checkKey();
}
$("#open-settings").onclick = openSettings;
$("#need-key-btn").onclick = openSettings;
$("#s-check").onclick = checkKey;
$("#s-save").onclick = async e => {
  e.preventDefault();
  const key = $("#s-key").value.trim();
  if (key !== S.get("apiKey") || !modelsCache) { if (!(await checkKey())) return; }
  S.set("apiKey", key);
  S.set("model", $("#s-model").value);
  S.set("lang", $("#s-lang").value);
  S.set("chunk", $("#s-chunk").value);
  S.set("screen", $("#s-screen").checked ? "1" : "0");
  dlg.close();
  refreshKeyBanner();
};
function refreshKeyBanner() { $("#need-key").hidden = !!S.get("apiKey"); }

/* ======================= 動画の追加 ======================= */
async function addVideo(file, handle) {
  if (!supported) { alert("このブラウザは動画処理（WebCodecs）に対応していません。最新のChromeまたはEdgeで開いてください。"); return; }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = {
    id, name: file.name, size: file.size, lastModified: file.lastModified,
    created: Date.now(), status: "queued", progress: 0, label: "準備中",
    chunkLen: +S.get("chunk", "300"), language: "", segments: [], chunks: null,
    wantScreen: S.get("screen", "1") === "1", screen: [], screenBatches: null,
  };
  try {
    Object.assign(job, await probe(file));
  } catch (e) {
    alert("この動画は読み込めませんでした。MP4 / MOV / WebM などの形式でお試しください。\n" + e.message);
    return;
  }
  if (!job.hasAudio) { alert("この動画には音声が入っていません。"); return; }
  if (!job.canDecodeAudio) { alert("この動画の音声形式はブラウザで読み込めません。"); return; }
  files.set(id, file);
  await store.putJob(job);
  if (handle) await store.putHandle(id, handle).catch(() => { });
  location.hash = "job/" + id;
  if (!S.get("apiKey")) { await setStatus(id, { status: "paused", label: "APIキーを設定すると開始します" }); openSettings(); return; }
  runJob(id);
}

async function pickFile() {
  if (window.showOpenFilePicker) {
    try {
      const [h] = await showOpenFilePicker({ types: [{ description: "動画", accept: { "video/*": [".mp4", ".mov", ".m4v", ".webm", ".mkv"] } }] });
      return { file: await h.getFile(), handle: h };
    } catch (e) { if (e.name === "AbortError") return null; }
  }
  return new Promise(res => {
    const inp = $("#file");
    inp.value = "";
    inp.onchange = () => res(inp.files[0] ? { file: inp.files[0] } : null);
    inp.click();
  });
}

function initHome() {
  const drop = $("#drop");
  const choose = async () => { const r = await pickFile(); if (r) addVideo(r.file, r.handle); };
  drop.onclick = choose;
  drop.onkeydown = e => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), choose());
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = async e => {
    e.preventDefault(); drop.classList.remove("over");
    const item = [...e.dataTransfer.items].find(i => i.kind === "file");
    const file = e.dataTransfer.files[0];
    if (!file) return;
    let handle = null;
    try { handle = await item?.getAsFileSystemHandle?.(); } catch { }
    addVideo(file, handle?.kind === "file" ? handle : null);
  };
}

async function renderHome() {
  refreshKeyBanner();
  const jobs = await store.allJobs();
  const box = $("#jobs");
  if (!jobs.length) { box.innerHTML = `<p class="empty">まだ動画がありません。</p>`; return; }
  box.innerHTML = jobs.map(j => {
    const live = running.has(j.id);
    const badge = j.status === "done" ? `<span class="badge done">完了</span>` :
      j.status === "error" ? `<span class="badge err">エラー</span>` :
      live ? `<span class="badge">${esc(j.label || "処理中")}</span>` : `<span class="badge pause">一時停止中</span>`;
    return `<a class="job" href="#job/${j.id}">
      <div class="n" title="${esc(j.name)}">${esc(j.name)}</div>
      <div class="m">${badge}${fmtDur(j.duration)}${j.language ? " · " + (LANGS[j.language] || j.language) : ""} · ${new Date(j.created).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
      ${j.status !== "done" ? `<div class="bar"><div style="width:${j.progress || 0}%"></div></div>` : ""}
      ${live ? "" : `<button class="del" data-id="${j.id}" title="削除">×</button>`}
    </a>`;
  }).join("");
  $$(".del", box).forEach(b => b.onclick = async e => {
    e.preventDefault(); e.stopPropagation();
    if (!confirm("この動画の字幕データを削除しますか？（元の動画ファイルは消えません）")) return;
    await store.deleteJob(b.dataset.id);
    files.delete(b.dataset.id);
    renderHome();
  });
}

/* ======================= 処理（音声抽出 → Gemini） ======================= */
async function setStatus(id, patch) {
  const job = await store.getJob(id);
  if (!job) return null;
  Object.assign(job, patch);
  await store.putJob(job);
  onJobChanged(job);
  return job;
}

async function getFileFor(job, { interactive = false } = {}) {
  if (files.has(job.id)) return files.get(job.id);
  const h = await store.getHandle(job.id).catch(() => null);
  if (h) {
    try {
      let perm = await h.queryPermission?.({ mode: "read" });
      if (perm !== "granted" && interactive) perm = await h.requestPermission({ mode: "read" });
      if (perm === "granted") { const f = await h.getFile(); files.set(job.id, f); return f; }
    } catch { }
  }
  return null;
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    if (!on && wakeLock && running.size === 0) { await wakeLock.release(); wakeLock = null; }
  } catch { }
}

const pausedErr = () => new GeminiError("一時停止しました", { kind: "paused" });

/** Geminiへの呼び出しを、回数制限・混雑時は待って再試行しながら行う */
let lastCall = 0;
async function withRetry(id, ctl, label, fn) {
  for (let attempt = 0; ; attempt++) {
    const gap = 4000 - (Date.now() - lastCall);   // 連続で叩きすぎない
    if (gap > 0) await sleep(gap);
    lastCall = Date.now();
    try { return await fn(); }
    catch (e) {
      if (!(e instanceof GeminiError) || !["rate", "overloaded"].includes(e.kind) || attempt >= 6 || ctl.stop) throw e;
      const wait = Math.ceil(Math.max(e.retryAfter, 5 * 2 ** Math.min(attempt, 3)));
      for (let s = wait; s > 0; s--) {
        if (ctl.stop) throw pausedErr();
        await setStatus(id, { status: "waiting", label: `${e.message}（あと${s}秒）` });
        await sleep(1000);
      }
      await setStatus(id, { status: "transcribe", label });
    }
  }
}

/** 同じ文字が続けて出ている区間をつなげる */
function mergeScreen(cues) {
  const out = [];
  for (const c of [...cues].sort((a, b) => a.start - b.start)) {
    const p = out.findLast(x => x.text === c.text && c.start <= x.end + 0.6);
    if (p) { p.end = Math.max(p.end, c.end); continue; }
    out.push({ ...c });
  }
  return out;
}

async function runJob(id) {
  if (running.has(id)) return;
  const ctl = { stop: false };
  running.set(id, ctl);
  keepAwake(true);
  try {
    let job = await store.getJob(id);
    if (!S.get("apiKey")) { await setStatus(id, { status: "paused", label: "APIキーを設定すると開始します" }); openSettings(); return; }
    const model = () => S.get("model", "gemini-3.5-flash-lite");
    const wantScreen = !!job.wantScreen;
    const speechEnd = wantScreen ? 85 : 100;

    // 1) 音声の取り出し（1回だけ。結果はブラウザ内に保存）
    let audio = await store.getAudio(id);
    if (!audio) {
      const file = await getFileFor(job);
      if (!file) { await setStatus(id, { status: "paused", label: "動画ファイルを選び直すと再開できます", needFile: true }); return; }
      job = await setStatus(id, { status: "audio", label: "音声を取り出し中", progress: 0, error: "", needFile: false });
      let last = 0;
      audio = await extractAudio(file, job.duration, p => {
        if (Date.now() - last > 400) { last = Date.now(); setStatus(id, { progress: Math.round(p * 80) / 10 }); }
      });
      await store.putAudio(id, audio);
    }

    // 1b) 画面の文字用に、絵が変わったところのフレームを集める
    let frames = wantScreen ? await store.getFrames(id) : null;
    if (Array.isArray(frames)) frames = { list: frames, sig: null };
    const grabFrames = async file => {
      let last = 0;
      await setStatus(id, { status: "audio", label: "画面の文字を探すため、映像を確認中 0%" });
      frames = await extractKeyframes(file, job.duration, p => {
        if (Date.now() - last > 500) { last = Date.now(); setStatus(id, { label: `画面の文字を探すため、映像を確認中 ${Math.round(p * 100)}%` }); }
      });
      await store.putFrames(id, frames);
    };
    if (wantScreen && !frames) { const f = await getFileFor(job); if (f) await grabFrames(f); }

    // 2) 音声: 話の切れ目で区切って、順番にGeminiへ
    job = await store.getJob(id);
    if (!job.chunks) { job.chunks = planChunks(job.duration, audio.energy, job.chunkLen); await store.putJob(job); }
    const total = job.duration;
    for (let i = 0; i < job.chunks.length; i++) {
      const c = job.chunks[i];
      if (c.done) continue;
      if (ctl.stop) throw pausedErr();
      const doneDur = job.chunks.filter(x => x.done).reduce((a, x) => a + (x.end - x.start), 0);
      const pct = 10 + (speechEnd - 10) * doneDur / total;
      const label = `音声の聞き取り・翻訳中（${i + 1} / ${job.chunks.length}）`;
      job = await setStatus(id, { status: "transcribe", label, progress: Math.round(pct * 10) / 10, error: "" });

      const piece = await sliceAudio(audio.blob, c.start, c.end);
      const context = job.segments.filter(s => s.end <= c.start + 0.5).slice(-5);
      const res = await withRetry(id, ctl, label, () => transcribeChunk({
        key: S.get("apiKey"), model: model(), audio: piece, duration: c.end - c.start, language: S.get("lang", "auto"), context,
      }));

      const segs = res.segments.map(s => ({ start: s.start + c.start, end: s.end + c.start, text: s.text, ja: s.ja }));
      refineTimes(segs, audio.energy);
      job = await store.getJob(id);
      const keep = job.segments.filter(s => s.start < c.start - 0.01 || s.start >= c.end);
      job.segments = tidy([...keep, ...segs], total);
      if (!job.language && res.language) job.language = res.language.toLowerCase().slice(0, 2);
      job.chunks[i].done = true;
      job.model = model();
      await store.putJob(job);
      onJobChanged(job, true);
    }

    // 3) 画面の文字: フレームを60枚ずつ送って、目立つ外国語の文字を訳す
    if (wantScreen) {
      if (!frames) {
        const f = await getFileFor(job);
        if (!f) { await setStatus(id, { status: "paused", label: "画面の文字を訳すには、動画ファイルを選び直してください", needFile: true }); return; }
        await grabFrames(f);
      }
      job = await store.getJob(id);
      if (!job.screenBatches) {
        const B = 60;
        job.screenBatches = [];
        for (let k = 0; k < frames.list.length; k += B) job.screenBatches.push({ from: k, to: Math.min(frames.list.length, k + B), done: false });
        job.screen ||= [];
        await store.putJob(job);
      }
      const nb = job.screenBatches.length;
      for (let b = 0; b < nb; b++) {
        const bt = job.screenBatches[b];
        if (bt.done) continue;
        if (ctl.stop) throw pausedErr();
        const label = `画面の文字を翻訳中（${b + 1} / ${nb}）`;
        job = await setStatus(id, { status: "transcribe", label, progress: Math.round((85 + 15 * b / nb) * 10) / 10, error: "" });
        const fs = frames.list.slice(bt.from, bt.to);
        const t0 = fs[0].t, t1 = fs[fs.length - 1].end;
        const speech = job.segments.filter(s => s.end > t0 && s.start < t1).slice(0, 80);
        const prevFrameT = frames.list[bt.from - 1]?.t;
        const found = await withRetry(id, ctl, label, () => readScreen({ key: S.get("apiKey"), model: model(), frames: fs, speech, prevFrameT }));
        const cues = refineScreenTimes(found, frames.sig).map(({ firstT, lastT, prevT, ...c }) => c);
        job = await store.getJob(id);
        job.screen = mergeScreen([...(job.screen || []), ...cues]);
        job.screenBatches[b].done = true;
        await store.putJob(job);
        onJobChanged(job, true);
      }
      await setStatus(id, { screenDone: true });
    }
    await setStatus(id, { status: "done", progress: 100, label: "", error: "", needFile: false });
  } catch (e) {
    console.error(e);
    const kind = e.kind || "error";
    if (kind === "paused") await setStatus(id, { status: "paused", label: "一時停止中" });
    else if (kind === "quota-day") await setStatus(id, { status: "paused", label: e.message + " 太平洋時間の0時（日本時間16〜17時）を過ぎると回数が戻るので、そのあと「再開」を押してください。設定で別のモデルに切り替えて続けることもできます。" });
    else if (kind === "auth") { await setStatus(id, { status: "paused", label: e.message }); openSettings(); }
    else await setStatus(id, { status: "error", label: "エラー: " + (e.message || e) });
  } finally {
    running.delete(id);
    keepAwake(false);
    const j = await store.getJob(id);
    if (j) onJobChanged(j);
  }
}

window.addEventListener("beforeunload", e => { if (running.size || exporting) { e.preventDefault(); e.returnValue = ""; } });

/* ======================= エディタ ======================= */
const video = $("#video");
const ed = { id: null, job: null, segs: [], screen: [], scrKey: "", mode: S.get("mode", "ja"), cur: -1, editing: false, saveTimer: null, url: null };
let exporting = null;

function onJobChanged(job, segsChanged = false) {
  if (!$("#home").hidden) { renderHomeSoon(); return; }
  if (job.id !== ed.id) return;
  ed.job = job;
  renderProgress();
  if ((segsChanged || !ed.segs.length) && !ed.editing) {
    ed.segs = job.segments.map(s => ({ ...s }));
    ed.screen = (job.screen || []).map(c => ({ ...c }));
    renderList();
  }
}
let homeTimer;
const renderHomeSoon = () => { clearTimeout(homeTimer); homeTimer = setTimeout(renderHome, 300); };

async function openJob(id) {
  const job = await store.getJob(id);
  if (!job) { location.hash = ""; return; }
  ed.id = id; ed.job = job; ed.cur = -1;
  ed.segs = job.segments.map(s => ({ ...s }));
  ed.screen = (job.screen || []).map(c => ({ ...c }));
  ed.scrKey = "";
  $("#ed-title").textContent = job.name;
  $("#ex-status").hidden = !(exporting && exporting.id === id);
  if (ed.url) { URL.revokeObjectURL(ed.url); ed.url = null; }
  video.removeAttribute("src"); video.load();
  const file = await getFileFor(job);
  attachFile(file);
  renderProgress();
  renderList();
  // 中断されていたジョブ（タブを閉じた等）は自動で再開
  if (job.status !== "done" && job.status !== "error" && !running.has(id) && !job.needFile && file && S.get("apiKey") && job.status !== "paused") runJob(id);
}

function attachFile(file) {
  $("#nofile").hidden = !!file;
  if (!file) return;
  ed.url = URL.createObjectURL(file);
  video.src = ed.url;
}

$("#relink").onclick = async () => {
  const job = ed.job;
  let file = await getFileFor(job, { interactive: true });
  if (!file) {
    const r = await pickFile();
    if (!r) return;
    if ((r.file.name !== job.name || r.file.size !== job.size) &&
      !confirm(`選んだファイル（${r.file.name}）は、元の動画（${job.name}）と違うようです。このまま使いますか？`)) return;
    file = r.file;
    files.set(job.id, file);
    if (r.handle) store.putHandle(job.id, r.handle).catch(() => { });
  }
  attachFile(file);
  if (job.needFile) { await setStatus(job.id, { needFile: false }); runJob(job.id); }
};

function renderProgress() {
  const j = ed.job;
  if (!j) return;
  const live = running.has(j.id);
  $("#ed-meta").textContent = [fmtDur(j.duration), j.language && (LANGS[j.language] || j.language) + " → 日本語", j.model].filter(Boolean).join(" · ");
  const pc = $("#ed-progress");
  pc.hidden = j.status === "done";
  $("#pc-label").textContent = live ? (j.label || "処理中") : j.status === "error" ? j.label : j.status === "paused" ? "一時停止中" : (j.label || "");
  $("#pc-pct").textContent = Math.round(j.progress || 0) + "%";
  $("#pc-bar").style.width = (j.progress || 0) + "%";
  $("#pc-note").textContent = live ? "このタブを開いたままにしてください（閉じても、あとで「再開」を押せば続きから処理できます）"
    : j.status === "paused" ? (j.label !== "一時停止中" ? j.label : "") : j.status === "error" ? "「再開」で続きからやり直せます。" : "";
  $("#pause").hidden = !live;
  $("#resume").hidden = live || j.status === "done";
  $$(".export button").forEach(b => b.disabled = (!ed.segs.length && !ed.screen.length) || !!exporting);
  $("#ex-screen").hidden = j.status !== "done" || !!j.screenDone || live;
  $("#ex-screen").disabled = !!exporting;
  $("#ex-burn").disabled ||= !files.has(j.id);
  $("#redo").disabled = live || !!exporting;
}

$("#pause").onclick = () => { const c = running.get(ed.id); if (c) c.stop = true; $("#pc-label").textContent = "区切りのいいところで止めます…"; };
$("#resume").onclick = async () => {
  if (!S.get("apiKey")) return openSettings();
  const job = ed.job;
  if (!(await store.getAudio(job.id)) && !(await getFileFor(job, { interactive: true }))) {
    $("#relink").click();
    return;
  }
  await setStatus(job.id, { status: "queued", label: "再開します", needFile: false });
  runJob(job.id);
};
$("#redo").onclick = async () => {
  if (!confirm("手で直した部分も含めて、字幕を最初から作り直しますか？（音声は保存済みのものを使います）")) return;
  await setStatus(ed.id, {
    segments: [], chunks: null, status: "queued", progress: 10, chunkLen: +S.get("chunk", "300"), language: "",
    wantScreen: S.get("screen", "1") === "1", screen: [], screenBatches: null, screenDone: false,
  });
  ed.segs = []; ed.screen = []; renderList();
  runJob(ed.id);
};

$("#ex-screen").onclick = async () => {
  if (!S.get("apiKey")) return openSettings();
  await setStatus(ed.id, { wantScreen: true, screenBatches: null, screenDone: false, status: "queued", label: "画面の文字を翻訳します" });
  runJob(ed.id);
};

/** 一覧の行（音声字幕 s / 画面文字 v）を時刻順に */
function rows() {
  return [
    ...ed.segs.map((x, i) => ({ k: "s", i, x })),
    ...ed.screen.map((x, i) => ({ k: "v", i, x })),
  ].sort((a, b) => a.x.start - b.x.start);
}
const itemOf = el => (el.dataset.k === "v" ? ed.screen : ed.segs)[+el.dataset.i];

function renderList() {
  $("#cnt").textContent = [ed.segs.length && `音声 ${ed.segs.length}件`, ed.screen.length && `画面 ${ed.screen.length}件`].filter(Boolean).join(" · ");
  const all = rows();
  $("#list").innerHTML = all.length ? all.map(({ k, i, x: s }) => `
    <div class="item${k === "v" ? " scr-item" : ""}" data-k="${k}" data-i="${i}">
      <div class="t">${k === "v" ? `<span class="tag">画面の文字</span>` : ""}<span class="tm">${fmtClock(s.start)} → ${fmtClock(s.end)}</span>
        <span class="nudge"><button data-n="-0.2" title="0.2秒早く">◀ 0.2s</button><button data-n="0.2" title="0.2秒遅く">0.2s ▶</button></span></div>
      <div class="ja" contenteditable="plaintext-only" spellcheck="false">${esc(s.ja)}</div>
      <div class="og" contenteditable="plaintext-only" spellcheck="false">${esc(s.text)}</div>
    </div>`).join("") : `<p class="empty" style="padding:12px">字幕ができると、ここに表示されます。</p>`;
  ed.cur = -1; ed.scrKey = "";
  renderProgress();
  tick();
}

function tick() {
  const i = cueAt(ed.segs, video.currentTime);
  const [m, s] = cueText(ed.segs[i], ed.mode);
  $("#cue-main").textContent = m;
  $("#cue-sub").textContent = s;
  const top = bottomBusy(ed.screen, video.currentTime);
  if (top !== ed.cueTop) { ed.cueTop = top; layoutCue(); }
  if (i !== ed.cur) {
    $(".item.cur")?.classList.remove("cur");
    const el = $(`.item[data-k="s"][data-i="${i}"]`);
    if (el) { el.classList.add("cur"); if ($("#follow").checked && !ed.editing) el.scrollIntoView({ block: "center", behavior: "smooth" }); }
    ed.cur = i;
  }
  // 画面文字の訳（原文の近くに表示）
  const t = video.currentTime, show = $("#show-screen").checked;
  const act = show ? ed.screen.map((c, k) => (t >= c.start && t < c.end && c.ja ? k : -1)).filter(k => k >= 0) : [];
  const key = act.join(",") + "|" + act.map(k => ed.screen[k].ja).join("|");
  if (key !== ed.scrKey) {
    ed.scrKey = key;
    $("#scr-layer").innerHTML = act.map(k => {
      const c = ed.screen[k], p = screenPlacement(c);
      return `<div class="scr${p.below ? "" : " above"}" style="left:${p.cx * 100}%;top:${p.y * 100}%">${esc(c.ja)}</div>`;
    }).join("");
    $$(".item.scr-on").forEach(e => e.classList.remove("scr-on"));
    act.forEach(k => $(`.item[data-k="v"][data-i="${k}"]`)?.classList.add("scr-on"));
  }
}
function loop() {
  if (!video.paused) tick();
  video.requestVideoFrameCallback ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
}

function layoutCue() {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const sc = Math.min(r.width / vw, r.height / vh);
  const cw = vw * sc, ch = vh * sc, ox = (r.width - cw) / 2, oy = (r.height - ch) / 2;
  const cue = $("#cue");
  cue.style.fontSize = Math.max(10, +$("#fs").value * ch) + "px";
  cue.style.left = cue.style.right = ox + cw * 0.05 + "px";
  if (ed.cueTop) { cue.style.top = oy + ch * 0.06 + "px"; cue.style.bottom = "auto"; }
  else { cue.style.bottom = oy + ch * 0.06 + "px"; cue.style.top = "auto"; }
  cue.classList.toggle("box", $("#box").checked);
  const L = $("#scr-layer");
  Object.assign(L.style, { left: ox + "px", top: oy + "px", width: cw + "px", height: ch + "px", fontSize: Math.max(9, +$("#fs").value * 0.82 * ch) + "px" });
}

function scheduleSave() {
  clearTimeout(ed.saveTimer);
  $("#saved").textContent = "編集中…";
  ed.saveTimer = setTimeout(async () => {
    const job = await store.getJob(ed.id);
    job.segments = ed.segs.map(s => ({ ...s })).sort((a, b) => a.start - b.start);
    job.screen = ed.screen.map(c => ({ ...c })).sort((a, b) => a.start - b.start);
    await store.putJob(job);
    $("#saved").textContent = "✓ 保存しました";
    setTimeout(() => $("#saved").textContent = "", 2000);
  }, 600);
}

function download(text, name, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: type + ";charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stem = () => ed.job.name.replace(/\.[^.]+$/, "");

async function exportBurn() {
  const job = ed.job, file = files.get(job.id);
  if (!file) return;
  const name = `${stem()}_日本語字幕.mp4`;
  let writable = null;
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: "MP4動画", accept: { "video/mp4": [".mp4"] } }] });
      writable = await h.createWritable();
    } catch (e) { if (e.name === "AbortError") return; }
  } else if (file.size > 1.5e9 && !confirm("このブラウザでは書き出し中の動画をメモリに保持します。大きな動画は失敗することがあります。続けますか？")) return;

  const el = $("#ex-status");
  exporting = { id: job.id };
  renderProgress();
  el.hidden = false;
  const started = Date.now();
  keepAwake(true);
  try {
    const screen = $("#show-screen").checked ? ed.screen : [];
    const blob = await burn(file, ed.segs, { mode: ed.mode, style: { scale: +$("#fs").value, box: $("#box").checked }, screen }, writable, p => {
      const el2 = Date.now() - started, eta = p > 0.02 ? el2 / p - el2 : 0;
      el.innerHTML = `字幕入り動画を作成中… ${Math.round(p * 100)}%${eta ? `（残り約${fmtDur(eta / 1000)}）` : ""}<div class="bar"><div style="width:${p * 100}%"></div></div>`;
    });
    if (blob) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    el.innerHTML = `✓ 字幕入り動画を保存しました（${name}）`;
  } catch (e) {
    console.error(e);
    try { await writable?.abort(); } catch { }
    el.innerHTML = `<span class="err-msg">書き出しに失敗しました：${esc(e.message || e)}</span>`;
  } finally {
    exporting = null;
    keepAwake(false);
    renderProgress();
  }
}

function initEditor() {
  video.addEventListener("timeupdate", tick);
  video.addEventListener("seeked", tick);
  video.addEventListener("loadedmetadata", layoutCue);
  new ResizeObserver(layoutCue).observe(video);
  document.addEventListener("fullscreenchange", () => setTimeout(layoutCue, 100));
  loop();
  video.addEventListener("dblclick", e => {
    e.preventDefault();
    document.fullscreenElement ? document.exitFullscreen() : $("#player").requestFullscreen();
  });

  $$(".seg button").forEach(b => {
    b.classList.toggle("on", b.dataset.mode === ed.mode);
    b.onclick = () => {
      ed.mode = b.dataset.mode; S.set("mode", ed.mode);
      $$(".seg button").forEach(x => x.classList.toggle("on", x === b));
      tick();
    };
  });
  $("#fs").value = S.get("fs", "0.055");
  $("#box").checked = S.get("box") === "1";
  $("#fs").oninput = () => { S.set("fs", $("#fs").value); layoutCue(); };
  $("#box").onchange = () => { S.set("box", $("#box").checked ? "1" : "0"); layoutCue(); };
  $("#show-screen").checked = S.get("showScreen", "1") === "1";
  $("#show-screen").onchange = () => { S.set("showScreen", $("#show-screen").checked ? "1" : "0"); ed.scrKey = ""; tick(); };

  const list = $("#list");
  list.addEventListener("click", e => {
    const item = e.target.closest(".item");
    if (!item) return;
    const s = itemOf(item);
    const n = e.target.closest(".nudge button");
    if (n) {
      const d = parseFloat(n.dataset.n);
      s.start = Math.max(0, +(s.start + d).toFixed(3));
      s.end = Math.max(s.start + 0.2, +(s.end + d).toFixed(3));
      item.querySelector(".t .tm").textContent = `${fmtClock(s.start)} → ${fmtClock(s.end)}`;
      ed.scrKey = "";
      video.currentTime = s.start;
      scheduleSave();
      return;
    }
    if (e.target.isContentEditable && !video.paused) return;
    video.currentTime = s.start + 0.01;
    tick();
  });
  list.addEventListener("focusin", () => ed.editing = true);
  list.addEventListener("focusout", () => ed.editing = false);
  list.addEventListener("input", e => {
    const s = itemOf(e.target.closest(".item"));
    if (e.target.classList.contains("ja")) s.ja = e.target.textContent; else s.text = e.target.textContent;
    ed.scrKey = "";
    tick(); scheduleSave();
  });
  list.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && e.target.isContentEditable) { e.preventDefault(); e.target.blur(); }
  });

  const scr = () => $("#show-screen").checked ? ed.screen : [];
  $("#dl-srt").onclick = () => download(toSRTAll(ed.segs, scr(), ed.mode), `${stem()}_${ed.mode}.srt`);
  $("#dl-vtt").onclick = () => download(toVTTAll(ed.segs, scr(), ed.mode), `${stem()}_${ed.mode}.vtt`, "text/vtt");
  $("#ex-burn").onclick = exportBurn;

  document.addEventListener("keydown", e => {
    if ($("#editor").hidden || e.target.isContentEditable || /INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName) || dlg.open) return;
    if (e.code === "Space") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
    if (e.key === "ArrowLeft") video.currentTime -= 3;
    if (e.key === "ArrowRight") video.currentTime += 3;
  });
}

/* ======================= ルーター / PWA ======================= */
function route() {
  const m = location.hash.match(/^#job\/(.+)$/);
  if (m) {
    $("#home").hidden = true; $("#editor").hidden = false;
    openJob(m[1]);
  } else {
    video.pause();
    ed.id = null;
    $("#home").hidden = false; $("#editor").hidden = true;
    renderHome();
  }
}

let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("#install").hidden = false; });
window.addEventListener("appinstalled", () => { $("#install").hidden = true; });
$("#install").onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("#install").hidden = true; };

// インストール後、Finderなどで「このアプリで開く」から動画を開けるように
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async params => {
    const h = params.files?.[0];
    if (h) addVideo(await h.getFile(), h);
  });
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW", e));
}

// 前回タブを閉じたときに処理中だったジョブは「一時停止」扱いにする
(async () => {
  for (const j of await store.allJobs()) {
    if (RUNNING_STATES.includes(j.status)) { j.status = "paused"; j.label = "一時停止中"; await store.putJob(j); }
  }
  initHome();
  initEditor();
  window.addEventListener("hashchange", route);
  route();
  if (!supported) {
    $("#need-key").hidden = false;
    $("#need-key").innerHTML = "<div><strong>このブラウザには対応していません</strong><br><span class='muted'>最新のChrome / Edge（パソコン）でお使いください。</span></div>";
  }
})();
