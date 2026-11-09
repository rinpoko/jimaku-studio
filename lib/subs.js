// 字幕データのユーティリティ（時刻整形・SRT/VTT・字幕描画）

export const fmtClock = t => {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = (t % 60).toFixed(1).padStart(4, "0");
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + s;
};

export const fmtDur = t => !t ? "" :
  t >= 3600 ? `${Math.floor(t / 3600)}時間${Math.round(t % 3600 / 60)}分` :
  t >= 60 ? `${Math.round(t / 60)}分` : `${Math.round(t)}秒`;

function ts(t, sep) {
  let ms = Math.round(Math.max(0, t) * 1000);
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
}

/** 表示モードに応じた [主字幕, 副字幕] */
export function cueText(s, mode) {
  const ja = (s?.ja || "").trim(), og = (s?.text || "").trim();
  if (!s) return ["", ""];
  if (mode === "orig") return [og, ""];
  if (mode === "both") return ja ? [ja, og] : [og, ""];
  return [ja || og, ""];
}

const joined = (s, mode) => cueText(s, mode).filter(Boolean).join("\n");

export const toSRT = (segs, mode) => segs
  .map((s, i) => `${i + 1}\n${ts(s.start, ",")} --> ${ts(s.end, ",")}\n${joined(s, mode)}\n`).join("\n");

export const toVTT = (segs, mode) => "WEBVTT\n\n" + segs
  .map(s => `${ts(s.start, ".")} --> ${ts(s.end, ".")}\n${joined(s, mode)}\n`).join("\n");

/** 二分探索で時刻tに表示すべき字幕のindex（なければ-1） */
export function cueAt(segs, t) {
  let lo = 0, hi = segs.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (segs[m].start <= t) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans >= 0 && t < segs[ans].end ? ans : -1;
}

// ---- Canvas描画（焼き込み用）。日本語の禁則と行長のバランスを取る
const NO_START = new Set([..."、。，．,.！？!?」』）)】ーっゃゅょッャュョァィゥェォ…～"]);
const isCJK = s => /[぀-ヿ一-鿿]/.test(s);

function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of text.split("\n")) {
    const toks = isCJK(para) ? [...para] : (para.match(/\S+\s*/g) || []);
    if (!toks.length) continue;
    const full = ctx.measureText(para).width;
    const n = Math.max(1, Math.ceil(full / maxW));
    const target = Math.min(maxW, full / n * 1.08);
    let line = "";
    for (const tok of toks) {
      const trial = line + tok;
      const w = ctx.measureText(trial.trimEnd()).width;
      if (NO_START.has(tok) && w <= maxW) { line = trial; continue; }
      const punctBreak = /[、。！？]$/.test(line) && w > target * 0.75 && full - w > target * 0.3;
      if (line.trim() && (w > target || punctBreak)) { out.push(line.trimEnd()); line = tok.trimStart(); }
      else line = trial;
    }
    if (line.trim()) out.push(line.trimEnd());
  }
  return out;
}

export const FONT_STACK = `"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic","Meiryo",sans-serif`;

/** ctx(W×H)の下部に字幕を描く。style = {scale, box} */
export function drawCue(ctx, W, H, main, sub, style) {
  if (!main) return;
  const size = Math.max(14, Math.round(H * (style.scale || 0.055)));
  const rows = [];
  for (const [text, sz, weight] of [[main, size, 700], [sub, Math.round(size * 0.72), 500]]) {
    if (!text) continue;
    ctx.font = `${weight} ${sz}px ${FONT_STACK}`;
    for (const ln of wrap(ctx, text, W * 0.9)) rows.push({ ln, sz, font: ctx.font });
  }
  const shown = rows.slice(-5);
  let y = H - H * 0.06 - shown.reduce((a, r) => a + r.sz * 1.35, 0);
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const r of shown) {
    const lh = r.sz * 1.35;
    ctx.font = r.font;
    const tw = ctx.measureText(r.ln).width;
    const x = (W - tw) / 2, cy = y + lh / 2;
    if (style.box) {
      const pad = r.sz * 0.3;
      ctx.fillStyle = "rgba(0,0,0,.62)";
      ctx.beginPath();
      ctx.roundRect(x - pad, y, tw + pad * 2, lh, pad);
      ctx.fill();
    } else {
      ctx.strokeStyle = "#000";
      ctx.lineWidth = Math.max(3, r.sz / 6);
      ctx.strokeText(r.ln, x, cy);
    }
    ctx.fillStyle = "#fff";
    ctx.fillText(r.ln, x, cy);
    y += lh;
  }
}
