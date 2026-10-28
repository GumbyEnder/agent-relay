// Verifies the voice lane module end to end: streaming SSE parse, first text,
// first audio, PCM byte count. Run from the repo root with the prod key env.
const path = require("path");
const jitiMod = require("jiti");
const jiti = (jitiMod.createJiti ? jitiMod.createJiti(__filename) : jitiMod(__filename));
const { voiceCompletion } = jiti(path.join(__dirname, "src/lib/buzzy/voice.ts"));

(async () => {
  const t0 = Date.now();
  let text = "";
  let audioChunks = 0;
  let firstTextAt = null;
  let firstAudioAt = null;
  const res = await voiceCompletion(
    [
      { role: "system", content: "You are BeeZilla, a no-nonsense project manager. One or two short sentences, ask one question." },
      { role: "user", content: "I run a fence company and lose quotes to slow decisions." },
    ],
    { maxTokens: 250 },
    {
      onText: (t) => { if (firstTextAt === null) firstTextAt = Date.now() - t0; text += t; },
      onAudio: () => { if (firstAudioAt === null) firstAudioAt = Date.now() - t0; audioChunks++; },
    },
  );
  console.log(JSON.stringify({
    ok: true,
    wallMs: Date.now() - t0,
    firstTextMs: firstTextAt,
    firstAudioMs: firstAudioAt,
    audioChunks,
    resultTtft: res.ttftMs,
    resultTtfa: res.ttfaMs,
    totalMs: res.totalMs,
    text: res.text.slice(0, 120),
    transcript: res.transcript.slice(0, 120),
    audioBytes: res.audioBytes,
  }, null, 2));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
