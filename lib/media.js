// ブラウザ内の動画処理（WebCodecs / mediabunny）。サーバーにも外部にも動画は送らない。
import {
  Input, Output, Conversion, BlobSource, BufferTarget, StreamTarget, ALL_FORMATS,
  OggOutputFormat, Mp4OutputFormat, Quality, canEncodeAudio,
} from "../vendor/mediabunny.min.mjs";
import { cueAt, cueText, drawCue } from "./subs.js";

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
export async function burn(file, segs, { mode, style }, writable, onProgress) {
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
        const i = cueAt(sorted, sample.timestamp);
        if (i >= 0) {
          const [m, s] = cueText(sorted[i], mode);
          drawCue(ctx, W, H, m, s, style);
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
