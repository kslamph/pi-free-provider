# Audio + video input on the free routes — what actually works

**Status:** study notes, 2026-10-18. Nothing here is implemented. No code was changed; every
number below comes from live probes run on this machine.
**Question:** the extension drops `video`/`pdf`/`audio` from the modalities its models advertise.
Can it carry audio and video instead, and if so what does the wire actually require?

**Answer in one line:** yes for audio and video *in principle* — two exact content-part
spellings work — but the Cline route accepts them only ~25 % of the time, and anything much
larger than a ~3 s clip never gets through regardless of how it is delivered. A public URL does
**not** help.

---

## 1. Why the modalities are dropped today

`capabilities.ts` (`PI_INPUT`) and `sources/opencode-config.ts` (`piInput()`) filter every feed
down to `["text","image"]` before the value reaches pi. The filter is not the real constraint —
pi is:

| layer | limit | evidence |
|---|---|---|
| pi model schema | `input: Type.Enum(["text","image"])` | `pi-coding-agent/dist/core/model-config.d.ts:18,201` |
| pi-ai content blocks | only `text`, `thinking`, `image`, `toolCall` | `pi-ai/dist/types.d.ts:242+` |
| openai-completions adapter | two branches only: `text`, `image_url` | `pi-ai/dist/api/openai-completions.js:938-944` |
| openai-responses adapter | two branches only: `input_text`, `input_image` | `pi-ai/dist/api/openai-responses-shared.js:148-161` |
| `@file` handling | non-image files are read as **utf-8** → a PDF/video becomes mojibake | `pi-coding-agent/dist/cli/file-processor.js:48` |
| `read` tool | text files and images only | `pi-coding-agent/dist/core/tools/read.js:53` |

`grep -c 'input_audio\|input_file' openai-completions.js openai-responses.js` → **0**. There is
no option, hook or `compat` flag that injects extra content parts (`samplingParams` merges
top-level body keys only). Any media support has to go through a request path the extension
owns.

The "fake an image block" shortcut is closed by measurement, not by reading docs —
`{"type":"image_url","image_url":{"url":"data:video/mp4;base64,…"}}` returns
**HTTP 400 `Unsupported image …`** from the upstream provider.

## 2. pi upstream: nothing is coming

- **PDF/file — refused on purpose.** #2736, #2923, #4287 (`DocumentContent`) all closed. badlogic
  on #4287: *"all of these PDF endpoints are terrible, and you loose full control over how the PDF
  is converted to plain text / (subsets of) pages are converted to images / how much of the PDF is
  truncated to fit into context — this is something you should implement yourself for full
  control."*
- **Video/audio — wanted, stalled.** #3200 is the canonical tracker (badlogic: *"this will take a
  while i'm afraid."*). PR #3349 (mimeTypes hack) closed unmerged; PR #10961 (`VideoContent`
  mirroring `ImageContent`, ~50 files, +1013/−204, tests green) closed awaiting approval and is
  reopenable; #10967 closed as a duplicate; #7279 (audio in tool results) closed.
- Repo was renamed: `badlogic/pi-mono` → `earendil-works/pi`.

Practical consequence: **do not plan on upstream support.** The extension-side route is the
sanctioned one, and it means owning transcoding, page/frame selection and truncation.

## 3. Method

Endpoint: `POST https://api.cline.bot/api/v1/chat/completions`, headers from the cached Cline
contract (`Cline/3.0.73`, `X-CLIENT-TYPE: cline-cli`, …) plus `Authorization` and a per-turn
`X-Task-ID`. `stream: false` works on this route (no agentic-shape gate). Response envelope is
`{"data":{"choices":[{"message":{"content":…}}]}}`.

Positive control first: the same content as a PNG → answered correctly. Without it a "PASS" is
meaningless.

Ground truth used:

- **synthetic** `/tmp/media/probe7.mp4` — ffmpeg `testsrc`, 128×128, 1.0 s, 5 frames, 5 089 bytes,
  a white **7** drawn in the centre. Truth: `DIGIT=7`.
- **synthetic** `/tmp/media/beeps.wav` — 3 × 0.15 s 1 kHz beeps + 1 × 0.9 s 250 Hz beep,
  16 kHz mono, 2.45 s. Truth: `SHORT=3, LONG=1`.
- **real** `~/video/runs/pilots/reception-dialogue-key-draft-s1000/reception-dialogue-key-draft-s1000.mp4`
  — 2 763 927 bytes, 12.25 s, 480×864 h264 + AAC, 1.8 Mbps. Two women at an office reception;
  the standing one holds a cream lunch box with a handle; burned-in Chinese subtitles; speech
  transcribed in `asr-transcript.txt` in the same directory.

Every run asked the model to answer only from the attached media, so a correct answer is
media-only knowledge.

## 4. Which content parts work

Probed against `cline-free/mimo-v2.6-flash`.

| content part | verdict |
|---|---|
| `{"type":"input_audio","input_audio":{"data":<b64>,"format":"wav"}}` | ✅ **3/3** `SHORT=3, LONG=1` |
| `{"type":"video_url","video_url":{"url":"data:video/mp4;base64,…"}}` | ✅ **3/3** `DIGIT=7` |
| `{"type":"input_video","video_url":<url>}` | 200, model sees nothing |
| `{"type":"input_video","input_video":{"data":…}}` | 200, model sees nothing |
| `{"type":"input_file","filename":"x.mp4","file_data":"data:video/mp4;…"}` | 200, model sees nothing |
| `{"type":"file","file":{…}}` (OpenRouter plugin spelling) | 200, model sees nothing |
| `{"type":"image_url","image_url":{"url":"data:video/mp4;…"}}` | **400** `Unsupported image …` |

**`video_url`, not `input_video`.** Meta's own docs use `input_video`, and pi's issue #10961
proposes `input_video` as the default part name — through Cline → OpenRouter only `video_url`
lands. Anything built from the upstream docs or the upstream PRs would silently send a part the
model ignores.

`input_audio` is understood by the routing layer, not just tolerated: an unsupported route returns
`No endpoints found that support input audio` with a routing funnel naming
`Filter by Input Audio Support`.

## 5. The public-URL hypothesis — tested and disproven

Hypothesis: the full-file failures were a request-body size restriction, so hand the provider a
public URL instead of inlining base64.

The real clip was uploaded to a temporary host (litterbox, 72 h TTL — the user explicitly
authorised exposing this clip for the test) and the A/B was run interleaved on the same model:

| arm | passes |
|---|---|
| 78 KB clip, public URL | **1/8** |
| 78 KB clip, inline base64 | **2/8** |
| 2.64 MB clip, public URL (body ≈ 200 bytes) | **0/3** |
| 2.64 MB clip, inline base64 | **0/3** |

With a URL the request body is tiny and it *still* fails, so the restriction is **not** in our
request body. It is on the media itself, further down.

Follow-up matrix, all delivered by public URL (5 reps each, interleaved):

| clip | passes |
|---|---|
| 3 s / 78 KB | 0/5 |
| 6 s / 65 KB | 0/5 |
| 12.25 s / 101 KB | 1/5 |
| 12.25 s / 307 KB | 1/5 |

The 3 s / 78 KB arm scoring 0/5 here, after scoring 2/8 and 3/3 earlier, is the flakiness below —
these per-cell numbers are too small to separate a duration cutoff from noise. What *is* solid:
the full-length clip never succeeded (0/6 across both transports, plus every earlier attempt),
while short clips sometimes do.

Note also `{"type":"input_file","filename":"clip.mp4","file_url":<url>}` → 200, media ignored.

## 6. Route flakiness is the dominant problem

The same 5 KB synthetic clip, same model, same spelling:

- early session: **3/3** pass
- ~40 minutes later: **1/5** pass

All failures are `HTTP 500 {"error":"empty response content","success":false}` — Cline's generic
wrapper error, which its **text-only** path returns too. A text-only control at the same moment
returns 200 with a perfectly good answer. So this is not media rejection; it is the route or the
upstream endpoint pool failing, and it varies over time rather than per file.

By contrast, failures that *are* media-specific are explicit and look different:
`400 Unsupported image …`, `404 No endpoints found that support input audio`,
`400 Invalid input` (Vercel private route), and one `The request was rejected because it was
considered high risk` that never reproduced.

**Consequence:** any media feature needs bounded retries with backoff, otherwise it will read as
broken ~75 % of the time.

## 7. Per-model results (Cline free route)

| model | advertised | observed |
|---|---|---|
| `cline-free/mimo-v2.6-flash` | text, image, audio, video | ✅ audio + video decode correctly (content verifiable) |
| `cline-free/muse-spark-1.3-contributor` | text, image, video, pdf | **unusable right now** — 4/4 video *and* plain text control 500 `empty response content`; video path could not be evaluated at all |
| `cline-free/nemotron-3.5-super-vl` | text, image, video | ❌ Vercel private route 400 `Invalid input` for both parts |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | text, image, video, audio | 200 but reports it sees nothing in every arm |
| `thinkingmachines/inkling:free` | text, image, audio | untestable — OpenRouter daily cap reached |
| `google/gemma-4-31b-it:free` | text, image, video | untestable — 429 temporarily rate-limited upstream |

Support is per model **and** per route, not per model family. That is exactly the granularity the
existing capability feeds already track.

## 8. The caption trap

Asked to "transcribe the Chinese speech", the model answered with the **burned-in subtitles**
(`饭放这里`, `莫总交代谁都不能进去`) — not the ASR line in `asr-transcript.txt`
(`泛放这里,沐总交代谁都不能进去`, whose opening is itself garbled). On these runs the model is
demonstrably reading the frame, and reading it correctly; it is not demonstrating audio
understanding.

Only the synthetic beep test proves audio decoding: `input_audio` returned `SHORT=3, LONG=1`
against a file with no visual channel at all.

For any evaluation on captioned footage (which is what this pipeline produces — see
`~/video/`), a caption-cropped or caption-free control is required, otherwise "the model
understood the video" can mean "the model OCRed the subtitles".

## 9. Zen side (OpenCode) — blocked before media even matters

Every hand-rolled Zen request now returns
`403 FreeTierError: "OpenCode's free tier can only be used from within OpenCode"`, including
plain text-only requests with `stream: true` and the `read` + `shell` tool pair that
`stream.ts` documents as the required agentic shape. That gate needs re-bisecting before Zen media
work can start; no Zen media probe was attempted.

## 10. What this means for the extension

Facts that constrain any design:

1. Media cannot ride pi's adapters. Either the extension registers its own API provider
   (`registerApiProvider` accepts an arbitrary `Api` string) and owns POST + SSE → events, or it
   injects parts at a layer pi does not expose. `convertMessages` *is* exported from
   `@earendil-works/pi-ai/api/openai-completions` and is reusable for the message array.
2. `ToolResultMessage.details` is arbitrary JSON and persisted in the session, so a media
   descriptor (`{path, mimeType, kind, bytes}`) can live there and the bytes can be read at
   request time — keeping session files small.
3. The transcript-rewrite-then-delegate pattern already exists in this codebase
   (`padZenRequest`), which is the natural place to splice a media part in.
4. Transcoding is not optional: what gets sent must be small, and the selection of frames is a
   product decision, not a transport detail.
5. Retries are not optional: measured success is ~25 %.
6. "Transcribe the speech" must be a distinct capability from "describe the video" (§8).

Open questions, in the order they block a plan:

- Is the real cutoff duration (frames) or bytes? Needs a proper n≥10 per arm run; the current
  cells are too noisy.
- Does the ~25 % failure rate recover, and is it per-account, per-model or time-of-day?
- Can a file-id / upload API be reached through Cline, which would sidestep re-sending the payload
  every turn (chat completions is stateless)?
- Is the Zen gate recoverable?

## 11. Reproducing

The probe harness now lives in the repo at `tools/mediaprobe/` — **gitignored**, never
committed, and regenerable:

```bash
cd tools/mediaprobe
./fixtures.sh                                       # rebuild every fixture (ffmpeg + pilot clip)
node now.mjs cline-free/mimo-v2.6-flash a250.mp4    # text control + one video arm
node cut.mjs cline-free/mimo-v2.6-flash             # uploads fixtures, runs the size matrix
```

| file | purpose |
|---|---|
| `lib.mjs` | helpers: fixture paths, Cline/Zen auth, `uploadTemporary()`, `cline()` |
| `fixtures.sh` | ffmpeg recipe for every fixture in `media/` |
| `media/` | fixtures: synthetic ground truth + re-encodes of the pilot clip along the size/duration axes |
| `probe.mjs`, `probe-cline.mjs`, `probe2–6.mjs` | content-part spelling sweeps (Zen / Cline) |
| `probe-real.mjs` | the real pilot clip, full size |
| `bisect.mjs`, `rep.mjs`, `rep2.mjs`, `now.mjs` | size and duration bisection, repeat-rate measurement |
| `urlprobe.mjs`, `urlprobe2.mjs`, `ab.mjs`, `cut.mjs`, `fullerr.mjs` | public-URL vs inline delivery |
| `muse.mjs` | muse-spark specifically |
| `audio.mjs` | real-speech audio + caption-cropped video |
| `control.mjs` | Zen text-only control |

Fixture sizes along the axes that were varied: `t1s/t3s/t3s_hi/t4s/t5s/t6s` (duration sweep at
200k), `a2s/a250/a300/a450` (bitrate sweep at ~3 s), `v200/v400/v800/v1200` (full clip at
descending bitrates), `d6_100` (6 s / 65 KB), `d12_60` (12.25 s / 101 KB), `d12_250` (12.25 s /
307 KB), `t12_noaudio` (full length, audio track stripped), `nocap3` (crop attempt),
`speech3` (3 s of the real ASR audio), plus `probe7.mp4/.png` and `beeps.wav`.

The URL arms upload to a temporary host at run time (`uploadTemporary()`, litterbox, 72 h TTL)
rather than carrying hardcoded links. The five litterbox URLs quoted in §5 were valid on
2026-10-18 and have since expired; `cut.mjs` regenerates equivalents.

Credentials are read from `~/.pi/agent/clinefree.json` and `~/.pi/agent/zenfree.json`; nothing is
written to them and no other local file is modified.
