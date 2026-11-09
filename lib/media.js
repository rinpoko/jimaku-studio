// ブラウザ内の動画処理（WebCodecs / mediabunny）。サーバーにも外部にも動画は送らない。
import {
  Input, Output, Conversion, BlobSource, BufferTarget, StreamTarget, ALL_FORMATS,
  OggOutputFormat, Mp4OutputFormat, Quality, canEncodeAudio, CanvasSink,
} from "../vendor/mediabunny.min.mjs";
import { cueAt, cueText, drawCue, drawScreenCue, bottomBusy } from "./subs.js";

export const STEP = 0.05; // 音量の記録間隔（秒）

const even = n => Math.max(2, Math.round(n / 2) * 2);

export async function probe(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const [duration, vt, at] = await Promise.all([
    input.computeDuration(), input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack(),
  ]);
  return {
    duration,
    width: vt?.displayWidth || 0, height: vt?.displayHeight || 0,
    hasAudio: !!at, canDecodeAudio: at ? await at.canDecode() : false,
  };
}

/** 動画から16kHzモノラルOpus音声を取り出し、同時に50msごとの音量(dB)を記録する */
export async function extractAudio(file, duration, onProgress) {
  const sr = (await canEncodeAudio("opus", { numberOfChannels: 1, sampleRate: 16000 })) ? 16000 : 48000;
  const n = Math.ceil(duration / STEP) + 20;
  const sum = new Float64Array(n), cnt = new Uint32Array(n);
  let buf = new Float32Array(0);

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new OggOutputFormat(), target });
  const conv = await Conversion.init({
    input, output, tracks: "primary", showWarnings: false,
    video: { discard: true },
    audio: {
      numberOfChannels: 1, sampleRate: sr, codec: "opus", bitrate: 24000, forceTranscode: true,
      process(sample) {
        const frames = sample.numberOfFrames;
        if (buf.length < frames) buf = new Float32Array(frames);
        sample.copyTo(buf, { planeIndex: 0, format: "f32-planar" });
        const rate = sample.sampleRate, t0 = sample.timestamp;
        for (let i = 0; i < frames; i++) {
          const b = Math.floor((t0 + i / rate) / STEP);
          if (b >= 0 && b < n) { sum[b] += buf[i] * buf[i]; cnt[b]++; }
        }
        return sample;
      },
    },
  });
  if (!conv.isValid) throw new Error("この動画の音声は読み込めませんでした（" + conv.discardedTracks.map(d => d.reason).join(", ") + "）");
  conv.onProgress = p => onProgress?.(p);
  await conv.execute();

  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) energy[i] = cnt[i] ? 10 * Math.log10(sum[i] / cnt[i] + 1e-10) : -100;
  return { blob: new Blob([target.buffer], { type: "audio/ogg" }), energy };
}

/**
 * 画面の文字を読むための代表フレームを集める。
 * 一定間隔で縮小画像を作り、カットが変わった時・画面の一部（文字など）が変わった時だけ保存する。
 * あわせて全サンプルの小さな白黒画像（sig）を残し、あとで文字が出た・消えた瞬間を細かく合わせるのに使う。
 * @returns {{list:{t:number,end:number,blob:Blob}[], sig:{w:number,h:number,times:Float32Array,data:Uint8Array}}}
 */
export async function extractKeyframes(file, duration, onProgress) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt || !(await vt.canDecode())) return { list: [], sig: null };
  const long = duration > 20 * 60;
  const step = long ? 1 : 0.5;          // 確認する間隔
  const minGap = long ? 4 : 1.5;        // 部分的な変化で拾う最短間隔
  const W = 640, H = even(640 * vt.displayHeight / vt.displayWidth);
  const sink = new CanvasSink(vt, { width: W, height: H, fit: "fill", poolSize: 2 });
  const tw = 64, th = Math.max(16, Math.round(64 * H / W)), N = tw * th;
  const small = new OffscreenCanvas(tw, th);
  const sctx = small.getContext("2d", { willReadFrequently: true });
  const luma = () => {
    const d = sctx.getImageData(0, 0, tw, th).data, out = new Uint8Array(N);
    for (let i = 0; i < N; i++) out[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    return out;
  };
  const diff = (a, b) => {
    let sum = 0, local = 0;
    for (let i = 0; i < N; i++) { const v = Math.abs(a[i] - b[i]); sum += v; if (v > 30) local++; }
    return { mean: sum / N, local };
  };

  const times = [];
  for (let t = 0.2; t < duration; t += step) times.push(+t.toFixed(3));
  const sigData = new Uint8Array(times.length * N), sigTimes = new Float32Array(times.length);
  const list = [];
  let prev = null, key = null, lastKey = -1e9, n = 0, m = 0;
  for await (const w of sink.canvasesAtTimestamps(times)) {
    n++;
    if (!w) continue;
    const t = times[n - 1];
    sctx.drawImage(w.canvas, 0, 0, tw, th);
    const cur = luma();
    sigData.set(cur, m * N); sigTimes[m++] = t;
    const cut = !prev || diff(prev, cur).mean > 18;
    const sinceKey = key ? diff(key, cur) : { mean: 999, local: 999 };
    const partial = sinceKey.local >= 12 || sinceKey.mean > 8;
    if ((cut && t - lastKey >= 0.5) || (partial && t - lastKey >= minGap) || t - lastKey >= 12) {
      const blob = w.canvas.convertToBlob
        ? await w.canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 })
        : await new Promise(r => w.canvas.toBlob(r, "image/jpeg", 0.75));
      list.push({ t, blob });
      key = cur; lastKey = t;
    }
    prev = cur;
    if (n % 20 === 0) onProgress?.(t / duration);
  }
  list.forEach((f, i) => f.end = list[i + 1]?.t ?? duration);
  return { list, sig: { w: tw, h: th, step, times: sigTimes.slice(0, m), data: sigData.slice(0, m * N) } };
}

/**
 * 画面文字の表示区間を、文字の位置(box)の見た目の変化で細かく合わせる。
 * 文字が見えているフレームを基準に、前後へ「同じ見た目が続く」所まで広げ、見た目が変わった所で止める。
 */
export function refineScreenTimes(cues, sig) {
  if (!sig?.times?.length) return cues;
  const { w, h, times, data, step } = sig, N = w * h, T = times.length;
  const idxAt = t => { let lo = 0, hi = T - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= t + 1e-3) lo = mid; else hi = mid - 1; } return lo; };
  for (const c of cues) {
    if (!c.box) continue;
    const [y0, x0, y1, x1] = c.box;
    const r0 = Math.max(0, Math.floor(y0 / 1000 * h)), r1 = Math.min(h - 1, Math.ceil(y1 / 1000 * h));
    const c0 = Math.max(0, Math.floor(x0 / 1000 * w)), c1 = Math.min(w - 1, Math.ceil(x1 / 1000 * w));
    const px = [];
    for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) px.push(y * w + x);
    if (px.length < 4) continue;
    // 文字の位置での、隣り合うサンプル間の見た目の変化量
    const jump = (a, b) => { let d = 0; for (const p of px) d += Math.abs(data[a * N + p] - data[b * N + p]); return d / px.length; };
    // 見えていると分かっている範囲 [firstT, lastT]、見えていないと分かっているフレーム prevT / c.end
    const firstT = c.firstT ?? c.start, lastT = c.lastT ?? c.start;
    const prevT = c.prevT ?? Math.max(0, firstT - 4);
    const iF = idxAt(firstT), iL = idxAt(lastT), iP = idxAt(prevT), iN = idxAt(c.end);
    // 出た瞬間 = prevT〜firstT の間で文字の位置が一番大きく変わった所
    let bestS = -1, js = iF;
    for (let j = Math.max(1, iP + 1); j <= iF; j++) { const d = jump(j - 1, j); if (d > bestS) { bestS = d; js = j; } }
    // 消えた瞬間 = lastT〜次のフレーム の間で一番大きく変わった所
    let bestE = -1, je = iL;
    for (let j = iL; j < Math.min(iN, T - 1); j++) { const d = jump(j, j + 1); if (d > bestE) { bestE = d; je = j; } }
    if (bestS > 2) c.start = +((times[js - 1] + times[js]) / 2).toFixed(2);
    if (bestE > 2) c.end = +((times[je] + times[je + 1]) / 2).toFixed(2);
  }
  return cues;
}

/** 保存済み音声から[start,end]を切り出す */
export async function sliceAudio(blob, start, end) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new OggOutputFormat(), target });
  const conv = await Conversion.init({
    input, output, trim: { start, end }, showWarnings: false,
    audio: { codec: "opus", bitrate: 24000 },
  });
  await conv.execute();
  return new Blob([target.buffer], { type: "audio/ogg" });
}

/** 話の途切れ目（音量が最も小さい所）で区切るように、chunkLen秒前後のチャンクに分ける */
export function planChunks(duration, energy, chunkLen) {
  const cuts = [0];
  const win = Math.round(0.6 / STEP);
  let t = chunkLen;
  while (t < duration - chunkLen * 0.25) {
    const radius = Math.min(25, chunkLen * 0.1);
    let best = t, bestV = Infinity;
    for (let c = t - radius; c <= t + radius; c += STEP) {
      const i = Math.round(c / STEP);
      let v = 0;
      for (let k = i - win; k <= i + win; k++) v += energy[k] ?? -100;
      if (v < bestV) { bestV = v; best = c; }
    }
    cuts.push(+best.toFixed(2));
    t = best + chunkLen;
  }
  cuts.push(duration);
  return cuts.slice(0, -1).map((s, i) => ({ start: s, end: cuts[i + 1], done: false }));
}

/** 音量の記録を使って、AIが返したおおよその時刻を発話の始まり・終わりに寄せる */
export function refineTimes(segs, energy) {
  const vals = Array.from(energy).filter(v => v > -99).sort((a, b) => a - b);
  if (vals.length < 20) return segs;
  const floor = vals[Math.floor(vals.length * 0.15)];
  const thr = Math.max(floor + 8, -55);
  const voiced = t => (energy[Math.round(t / STEP)] ?? -100) > thr;

  for (const s of segs) {
    // 開始: 無音から始まっていたら最大1秒先の発話開始へ / 発話中なら最大0.4秒前へ
    if (!voiced(s.start)) {
      for (let t = s.start; t < Math.min(s.start + 1, s.end - 0.3); t += STEP) if (voiced(t)) { s.start = t; break; }
    } else {
      let t = s.start;
      while (t > s.start - 0.4 && voiced(t - STEP)) t -= STEP;
      s.start = t;
    }
    // 終了: 無音で終わっていたら最大1.5秒手前の発話終わり+0.25秒へ
    if (!voiced(s.end)) {
      let t = s.end;
      while (t > Math.max(s.end - 1.5, s.start + 0.6) && !voiced(t)) t -= STEP;
      s.end = Math.min(s.end, t + 0.25);
    }
  }
  return segs;
}

/** 字幕を整える: 並べ替え・重なり解消・短すぎる表示の延長 */
export function tidy(segs, duration) {
  segs.sort((a, b) => a.start - b.start);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i], nx = segs[i + 1];
    s.start = Math.max(0, s.start);
    s.end = Math.min(duration || Infinity, Math.max(s.end, s.start + 0.5));
    const minEnd = s.start + Math.min(1.2, 0.35 + (s.ja || s.text || "").length * 0.08);
    if (s.end < minEnd) s.end = minEnd;
    if (nx && s.end > nx.start - 0.04) s.end = Math.max(s.start + 0.3, nx.start - 0.04);
    s.start = +s.start.toFixed(3); s.end = +s.end.toFixed(3);
  }
  return segs;
}

/** 字幕を焼き込んだMP4を作る。writableがあれば直接ディスクへ、なければメモリ上に作る */
export async function burn(file, segs, { mode, style, screen = [] }, writable, onProgress) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error("映像トラックがありません");
  const W = even(vt.displayWidth), H = even(vt.displayHeight);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const target = writable ? new StreamTarget(writable, { chunked: true }) : new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: writable ? false : "in-memory" }), target });
  const sorted = [...segs].sort((a, b) => a.start - b.start);

  const conv = await Conversion.init({
    input, output, tracks: "primary", showWarnings: false,
    video: {
      forceTranscode: true, codec: "avc", bitrate: new Quality("high"),
      processedWidth: W, processedHeight: H,
      process(sample) {
        ctx.clearRect(0, 0, W, H);
        sample.draw(ctx, 0, 0, W, H);
        for (const c of screen) if (sample.timestamp >= c.start && sample.timestamp < c.end) drawScreenCue(ctx, W, H, c, style);
        const i = cueAt(sorted, sample.timestamp);
        if (i >= 0) {
          const [m, s] = cueText(sorted[i], mode);
          drawCue(ctx, W, H, m, s, style, bottomBusy(screen, sample.timestamp));
        }
        return canvas;
      },
    },
  });
  if (!conv.isValid) throw new Error("この動画は書き出せません（" + conv.discardedTracks.map(d => d.reason).join(", ") + "）");
  conv.onProgress = p => onProgress?.(p);
  await conv.execute();
  return writable ? null : new Blob([target.buffer], { type: "video/mp4" });
}
