// Google Gemini API（無料枠）で、音声の聞き取り＋日本語訳を一度に行う
const BASE = "https://generativelanguage.googleapis.com/v1beta";

export const PREFERRED_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash", "gemini-2.5-flash-lite"];

export class GeminiError extends Error {
  constructor(message, { kind = "error", retryAfter = 0, status = 0 } = {}) {
    super(message);
    this.kind = kind;            // "quota-day" | "rate" | "auth" | "overloaded" | "error"
    this.retryAfter = retryAfter; // 秒
    this.status = status;
  }
}

async function call(key, path, init = {}) {
  let r;
  try {
    r = await fetch(BASE + path, {
      ...init,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key, ...(init.headers || {}) },
    });
  } catch (e) {
    throw new GeminiError("Googleに接続できませんでした。ネット接続を確認してください。", { kind: "overloaded", retryAfter: 15 });
  }
  if (r.ok) return r.json();

  const body = await r.json().catch(() => ({}));
  const err = body.error || {};
  const details = err.details || [];
  const retry = details.find(d => (d["@type"] || "").includes("RetryInfo"))?.retryDelay;
  const retryAfter = retry ? parseFloat(retry) : 0;
  const quotaIds = details.filter(d => (d["@type"] || "").includes("QuotaFailure"))
    .flatMap(d => (d.violations || []).map(v => v.quotaId || ""));
  const msg = err.message || r.statusText;

  if (r.status === 429) {
    if (quotaIds.some(q => /PerDay/i.test(q)))
      throw new GeminiError("このモデルの本日の無料枠を使い切りました。", { kind: "quota-day", status: 429 });
    throw new GeminiError("無料枠の回数制限に達しました。少し待って再試行します。", { kind: "rate", retryAfter: retryAfter || 30, status: 429 });
  }
  if (r.status === 400 && /API key/i.test(msg) || r.status === 401 || r.status === 403)
    throw new GeminiError("APIキーが正しくないか、使えない状態です。設定を確認してください。（" + msg + "）", { kind: "auth", status: r.status });
  if (r.status === 500 || r.status === 503 || r.status === 504)
    throw new GeminiError("Gemini側が混み合っています。少し待って再試行します。", { kind: "overloaded", retryAfter: 20, status: r.status });
  if (r.status === 404)
    throw new GeminiError("モデルが見つかりません。設定でモデルを選び直してください。（" + msg + "）", { kind: "auth", status: 404 });
  throw new GeminiError(msg, { status: r.status });
}

/** このキーで使える、音声入力可能なテキスト生成モデル一覧 */
export async function listModels(key) {
  const out = [];
  let token = "";
  do {
    const j = await call(key, `/models?pageSize=200${token ? "&pageToken=" + token : ""}`);
    out.push(...(j.models || []));
    token = j.nextPageToken || "";
  } while (token);
  return out
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => ({ id: m.name.replace(/^models\//, ""), label: m.displayName || m.name }))
    .filter(m => /^gemini-/.test(m.id) && !/(tts|image|live|embedding|robotics|audio|native|computer|omni)/i.test(m.id));
}

export function pickDefaultModel(models) {
  const ids = models.map(m => m.id);
  return PREFERRED_MODELS.find(p => ids.includes(p)) || ids.find(i => /flash-lite/.test(i)) || ids.find(i => /flash/.test(i)) || ids[0] || "";
}

const blobToBase64 = blob => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(",")[1]);
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});

const LANG_NAMES = { en: "英語", zh: "中国語", ko: "韓国語", es: "スペイン語", fr: "フランス語", de: "ドイツ語", it: "イタリア語", pt: "ポルトガル語", ru: "ロシア語", th: "タイ語", vi: "ベトナム語", id: "インドネシア語", ja: "日本語" };

const SYSTEM = `あなたはプロの映像字幕制作者です。与えられた音声を聞き取り、字幕データを作ります。
ルール:
- 実際に話されている言葉だけを正確に書き起こす。音楽・効果音・無音部分は字幕にしない。聞こえない言葉を推測で作らない。
- 1つの字幕は1〜7秒程度。文や句の切れ目で区切り、長い発話は複数の字幕に分ける。
- start / end は「この音声の先頭からの経過時間」を "MM:SS.mmm"（例 "01:23.450"）で、発話の始まりと終わりにできるだけ正確に合わせる。
- text は話された言語のままの原文。
- ja は自然で読みやすい日本語字幕。直訳調を避け、話し言葉として簡潔に（目安30文字以内）。固有名詞は一般的なカタカナ表記。原文が日本語なら ja は text と同じでよい。
- 前のパートの文脈が与えられたら、呼び方・用語・口調をそれに合わせる。
- 話し声が全くなければ segments は空配列にする。`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    language: { type: "STRING", description: "話されている主な言語のISO 639-1コード" },
    segments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          start: { type: "STRING" }, end: { type: "STRING" },
          text: { type: "STRING" }, ja: { type: "STRING" },
        },
        required: ["start", "end", "text", "ja"],
        propertyOrdering: ["start", "end", "text", "ja"],
      },
    },
  },
  required: ["language", "segments"],
  propertyOrdering: ["language", "segments"],
};

/** "MM:SS.mmm" / "HH:MM:SS.mmm" / 秒数 → 秒 */
export function parseTime(v) {
  if (typeof v === "number") return v;
  const s = String(v || "").trim().replace(",", ".");
  if (!s) return NaN;
  const parts = s.split(":").map(Number);
  if (parts.some(isNaN)) return NaN;
  return parts.reduce((a, p) => a * 60 + p, 0);
}

/** 途中で切れたJSONを、最後の完全な字幕までで閉じて救済する */
function salvage(text) {
  try { return JSON.parse(text); } catch { }
  const i = text.lastIndexOf("},");
  if (i > 0) {
    try { return JSON.parse(text.slice(0, i + 1) + "]}"); } catch { }
  }
  throw new GeminiError("AIの応答を読み取れませんでした。", { kind: "overloaded", retryAfter: 5 });
}

/**
 * 1チャンク分の音声を送って、字幕（チャンク先頭からの相対秒）を得る
 * @returns {{language:string, segments:{start:number,end:number,text:string,ja:string}[]}}
 */
export async function transcribeChunk({ key, model, audio, duration, language, context }) {
  const data = await blobToBase64(audio);
  const mm = String(Math.floor(duration / 60)).padStart(2, "0") + ":" + (duration % 60).toFixed(1).padStart(4, "0");
  let prompt = `この音声（長さ ${mm}）の字幕データを作ってください。タイムスタンプは ${mm} を超えないこと。`;
  if (language && language !== "auto") prompt += `\n話されている言語は主に${LANG_NAMES[language] || language}です。`;
  if (context?.length) {
    prompt += "\n\n【直前のパートの最後（文脈の参考。字幕には含めない）】\n" +
      context.map(s => `${s.text} → ${s.ja}`).join("\n");
  }

  const j = await call(key, `/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/ogg", data } }, { text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, maxOutputTokens: 65536 },
    }),
  });

  const cand = j.candidates?.[0];
  if (!cand) {
    const why = j.promptFeedback?.blockReason;
    throw new GeminiError(why ? `AIが処理を拒否しました（${why}）` : "AIから応答がありませんでした。", { kind: why ? "error" : "overloaded", retryAfter: 5 });
  }
  const text = (cand.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
  const parsed = salvage(text);
  const segs = (parsed.segments || []).map(s => ({
    start: parseTime(s.start), end: parseTime(s.end),
    text: String(s.text || "").trim(), ja: String(s.ja || "").trim(),
  })).filter(s => isFinite(s.start) && isFinite(s.end) && (s.text || s.ja))
    .map(s => ({ ...s, start: Math.min(Math.max(0, s.start), duration), end: Math.min(Math.max(s.end, s.start + 0.3), duration + 0.5) }));
  return { language: parsed.language || "", segments: segs, truncated: cand.finishReason === "MAX_TOKENS" };
}

// ---- 画面に出る文字（タイトル・キャッチコピー・テロップ）の読み取りと翻訳 ----
const SCREEN_SYSTEM = `あなたはプロの映像翻訳者です。動画から抜き出したフレーム画像（番号つき）を見て、画面に目立つように表示されている「日本語以外の文字」を見つけ、日本語に訳します。
対象にするもの:
- タイトル、キャッチコピー、商品コピー、テロップ、章の見出し、歌詞テロップ、大きく映った看板や画面上のメッセージなど、視聴者に読ませる意図がはっきりした文字。
対象にしないもの:
- 日本語の文字。
- 小さい文字、細かい注意書き、エンドロールの名前の羅列。
- ロゴ、ブランド名・商品名だけのもの、チャンネル名、テレビ局のマーク、時刻・気温などの常時表示。
- 画面下部の台詞字幕（話し声の字幕）。参考として渡す「音声の字幕」と同じ内容の文字。
ルール:
- 同じ文字が複数のフレームに出ている場合は1件にまとめ、その文字が見えている全てのフレーム番号を frames に入れる。
- 1つの画面に別々の文字のかたまりがあれば、別の件にする。
- box_2d はその文字のかたまりの位置で、[ymin, xmin, ymax, xmax] を 0〜1000 に正規化した整数で示す。
- text は画面の原文どおり、ja は自然な日本語訳。コピーは意味と雰囲気が伝わる短い訳にする。
- 該当する文字がなければ items は空配列にする。`;

const SCREEN_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          frames: { type: "ARRAY", items: { type: "INTEGER" } },
          box_2d: { type: "ARRAY", items: { type: "INTEGER" } },
          text: { type: "STRING" }, ja: { type: "STRING" },
        },
        required: ["frames", "box_2d", "text", "ja"],
        propertyOrdering: ["frames", "box_2d", "text", "ja"],
      },
    },
  },
  required: ["items"],
};

const clock = t => String(Math.floor(t / 60)).padStart(2, "0") + ":" + (t % 60).toFixed(1).padStart(4, "0");

/**
 * フレーム群を送り、画面文字の一覧を得る
 * @param frames {{t:number,end:number,blob:Blob}[]}  idx は配列内の位置（1始まりで送る）
 * @param speech その時間帯の音声字幕（重複を避けるための参考）
 */
export async function readScreen({ key, model, frames, speech, prevFrameT }) {
  const parts = [];
  for (let i = 0; i < frames.length; i++) {
    parts.push({ text: `#${i + 1}（${clock(frames[i].t)}）` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: await blobToBase64(frames[i].blob) } });
  }
  let prompt = `上の${frames.length}枚のフレームから、目立つ外国語の文字を探して日本語に訳してください。frames には上の番号（#の数字）を入れてください。`;
  if (speech?.length) prompt += "\n\n【この時間帯の音声の字幕（参考。これと同じ内容の文字は対象外）】\n" + speech.map(s => s.text).join("\n");
  parts.push({ text: prompt });

  const body = {
    systemInstruction: { parts: [{ text: SCREEN_SYSTEM }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCREEN_SCHEMA, maxOutputTokens: 32768, mediaResolution: "MEDIA_RESOLUTION_MEDIUM" },
  };
  let j;
  try {
    j = await call(key, `/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    // mediaResolution に対応していないモデルでは、指定を外してもう一度
    if (e.status !== 400 || !/media.?resolution/i.test(e.message)) throw e;
    delete body.generationConfig.mediaResolution;
    j = await call(key, `/models/${encodeURIComponent(model)}:generateContent`, { method: "POST", body: JSON.stringify(body) });
  }
  const cand = j.candidates?.[0];
  if (!cand) throw new GeminiError("AIから応答がありませんでした。", { kind: "overloaded", retryAfter: 5 });
  const parsed = salvage((cand.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join(""));

  // フレーム番号 → 時間帯。連続するフレームはひとつの表示区間にまとめる
  const cues = [];
  for (const it of parsed.items || []) {
    const ja = String(it.ja || "").trim(), text = String(it.text || "").trim();
    if (!ja || !text) continue;
    const box = Array.isArray(it.box_2d) && it.box_2d.length === 4 ? it.box_2d.map(v => Math.max(0, Math.min(1000, +v || 0))) : null;
    const idx = [...new Set((it.frames || []).map(n => n - 1).filter(n => n >= 0 && n < frames.length))].sort((a, b) => a - b);
    let run = null;
    for (const i of idx) {
      if (run && i === run.last + 1) { run.last = i; continue; }
      if (run) cues.push({ start: frames[run.first].t, end: frames[run.last].end, text, ja, box, firstT: frames[run.first].t, lastT: frames[run.last].t, prevT: frames[run.first - 1]?.t ?? (prevFrameT ?? 0) });
      run = { first: i, last: i };
    }
    if (run) cues.push({ start: frames[run.first].t, end: frames[run.last].end, text, ja, box, firstT: frames[run.first].t, lastT: frames[run.last].t, prevT: frames[run.first - 1]?.t ?? (prevFrameT ?? 0) });
  }
  return cues;
}
