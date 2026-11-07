# Stagegen Planner: v2 Generate and Choreograph

> This plan uses the Elephant-Goldfish Method (EGM). The **Elephant** is the long-context session that knows the existing Stagegen MVP and drafts the plan. **Goldfish** are fresh reviewers that see only this file and its referenced repository files. Their findings and resolutions are recorded in section 12.

Status: **FINAL v5 - EGM conditional go; owner decisions required before M0**  
Date: 2026-11-07

## 1. Outcome

Stagegen v2 lets an operator:

1. Import an image or video for a song section and put it on stage immediately.
2. Pan and zoom across it with beat-snapped keyframes.
3. Optionally generate stills and short video loops through the Open Higgsfield kie.ai path.
4. Publish an immutable show revision to show laptops.
5. Run without internet and fail safely if the server, LAN, GPU, or decoder has trouble.

The MVP already uploads and analyses audio, refines per-section visual plans, renders audio-reactive GLSL gradients, and synchronizes studio/show browsers over WebSocket.

## 2. Scope

### v2 includes

- Stable section UIDs and revision-bound async work.
- Local image/video import before paid generation.
- One primary plate per section over the existing gradient.
- Beat-relative pan/zoom as a 2D UV crop; no fake 3D depth.
- Draft versus immutable published revisions.
- Show cache, readiness tests, health heartbeats, panic controls, and gradient/poster fallbacks.
- Server-side kie.ai still and image-to-video jobs with local download.
- Atomic, price-based budget reservation before paid work.
- Section rename, boundary move, split, and merge after the core stage workflow works.
- Track and Live modes.
- Exported normalized loops and cue sheet for an independent backup player.

### v2 excludes

- Depth maps, cut-outs, 3D parallax, rotation, PerspectiveCamera, and arbitrary overlay stacks.
- Complete-show MP4/ProRes export, MIDI/OSC/timecode, multi-user accounts, and local model inference.
- Mutating a published revision. Changes stay in draft until explicitly published.

## 3. Ownership, authorization, and transactions

| Owner | v2 responsibility |
|---|---|
| C++ core (`core/src`) | HTTP/WS, analysis, canonical project state, published manifests, show state, media serving, authorization, presence/health |
| Node gateway (`gateway`) | LLM refinement, kie adapter, paid-job journal, polling/recovery, provider download, ffmpeg normalization, budget ledger |
| Studio (`web/src/studio`) | Import/generate/approve/activate, camera editing, publishing, output health, panic controls |
| Show (`web/src/show`) | Pinned manifest, cached media, compositor, readiness/preflight, local fallbacks |

The core currently listens on `0.0.0.0`, so v2 adds scoped authorization before paid or destructive APIs. A locally displayed one-time pairing code creates an HttpOnly, SameSite=Strict operator session. Show laptops pair with separate read-only/output tokens. HTTP and WebSocket commands validate session/token, Origin, Host, role, and project. A browser's self-declared `role` never grants authority.

API keys come from the existing encrypted Settings entry (`kie`) or `KIE_API_KEY`. Keys are never returned, journaled, broadcast, or exposed to browsers.

Canonical project data uses immutable snapshots. The account database is outside every project:

```text
data/generation.sqlite        account-wide gateway jobs, budgets, and reconciliation
data/projects/<id>/
  state/<revision>.json       analysis + plan + draft scene + asset metadata
  project-head.json           atomically replaced committed revision pointer
  assets/<generated names>    normalized media
  staging/<stagingId>/        uncommitted import/generation results
  manifests/<publishRev>.json immutable published show revisions
  show-state.json             latest cue state and server boot id
  exports/<publishRev>/       normalized loops and cue sheet
```

Every mutation carries `baseRevision`. Core validates it, writes/fsyncs a complete new snapshot, then atomically replaces `project-head.json`; only then does it broadcast. A stale base returns `409`. Migration is idempotent and commits one snapshot. This prevents analysis, plan, scene, and asset metadata from splitting across crashes or concurrent read-modify-write operations.

The paid-job and budget database is actually account-wide at `data/generation.sqlite`, keyed by project. It is not deleted with a project; financial and reconciliation rows follow the configured retention policy. The hard cap covers spending initiated through Stagegen. External kie.ai account spending is outside the cap unless a provider balance API is available and reconciled.

## 4. Data contracts

```jsonc
// asset inside state snapshot
{ "id": "a_123", "sectionUid": "s_123", "kind": "image|video",
  "file": "assets/a_123.mp4", "poster": "assets/a_123.jpg",
  "width": 1920, "height": 1080, "durationSec": 8.0,
  "source": "import|kie", "sourceAssetId": null,
  "prompt": null, "model": null, "jobId": null,
  "status": "candidate|approved|rejected", "createdAt": 0 }

// scene inside state snapshot
{ "sections": { "s_123": {
    "assetId": "a_123", "opacity": 1, "tint": 0.2,
    "loopMode": "baked|none", "cameraLoop": "hold|pingpong",
    "camera": [
      { "beat": 0, "x": .5, "y": .5, "zoom": 1, "ease": "inOut" },
      { "beat": 32, "x": .7, "y": .4, "zoom": 1.45, "ease": "inOut" }
    ]
  } } }
```

`x,y` are normalized focus coordinates. `zoom=1` is the largest cover-fit crop; larger values show a smaller source rectangle. Crop bounds are clamped, so unreachable focus points visibly stop at the edge instead of revealing empty pixels. `ease` belongs to the segment ending at that key; `hold` does not interpolate.

Approval and activation are separate. Multiple assets may be approved, but each section has one active `assetId`. Activation is an atomic core mutation. An asset cannot be deleted while referenced by draft, a published manifest, another asset's `sourceAssetId`, or a pending job; the API returns `409` with blockers.

## 5. Stable section and async-work invariants

- New sections get stable random UIDs; numeric IDs are display order only. Live cues and manifests always use UIDs.
- One-time migration backs up existing data, maps old plan entries by index, then commits a new snapshot.
- Section edits are explicit commands (`rename`, `moveBoundary`, `split`, `merge`) with `baseRevision` and lineage UIDs. Core allocates UIDs.
- Validate unique UIDs, sorted contiguous intervals, 500 ms minimum length, full track coverage, track duration, and all references. Downbeat snap is default; if none is close, keep the requested time.
- Boundary move keeps UID. Keys remain beat-relative and keys beyond the shortened section are clamped to its last beat after operator preview.
- Split keeps the left UID and creates the right UID. The right copies the plan text but begins with no active scene. Candidate/approved files remain in the reusable asset library.
- Merge keeps the first UID. The operator chooses the active scene. The other scene and plan are archived in the transaction; its assets remain reusable.
- Analysis metrics are recomputed by C++ from persisted sufficient statistics, including spectral centroid. Browser values are never authoritative.
- Refinement/generation results carry `analysisRevision`. Stale results enter the asset library but never alter the current plan/scene automatically.
- Replacing audio starts a new analysis lineage, clears the new draft scene, and retains old assets/manifests. Audio replacement/project deletion is blocked while paid jobs are nonterminal unless the operator first abandons/reconciles them.
- Published manifests never change after draft edits.

## 6. Free stage workflow first

### 6.1 Import and normalize

1. Core issues a random `stagingId` and streams the upload into `staging/<stagingId>/input`, never into committed assets.
2. Core checks extension, MIME signature, decoded dimensions/duration, and size limits, then dispatches only `{projectId, stagingId, requestedProfile}` to the authenticated loopback gateway.
3. Gateway normalizes inside that staging directory. Images become JPEG or PNG, EXIF removed, no larger than `output long side x 1.25`. Video becomes H.264 High, yuv420p, no audio, `+faststart`, at most 1920 px on the long side, plus a poster JPEG. The same profile applies to imported and generated results. It may bake tail-to-head `xfade` or ping-pong for preview.
4. Gateway returns sanitized relative filenames, hashes, sizes, MIME, dimensions, and duration through the authenticated outbox/ACK protocol.
5. Core reopens and verifies staged files, fsyncs, moves them to content-addressed final paths, and commits asset metadata in a new snapshot. Only committed assets may be previewed, approved, or activated. Uncommitted staging directories are recoverable orphans cleaned after the retention window; commit retry is idempotent by `stagingId`.

Use generated filenames, canonical root containment, and ffmpeg argument arrays. Never use user filenames as paths.

Default output profile is 1920x1080 at 60 Hz until the real LED profile is recorded. Hard ceilings: images <=40 MB, <=100 megapixels, <=16,384 px per side; videos <=500 MB, <=60 seconds, <=7680x4320; normalization <=10 minutes and <=2 GB temporary output; project assets <=20 GB; refuse new work above 80% server-disk use. Failure/interruption removes temporary files and records a retryable error. Startup removes abandoned temp files older than 24 hours. Loop baking and its three-cycle approval preview are part of M0 import.

### 6.2 Compositor and transport

- Keep the Three.js gradient pass; add one orthographic textured-quad plate pass.
- Pan/zoom changes UV crop coordinates. v2 supports normal premultiplied-alpha compositing, opacity, and palette tint.
- Render gradient and plate in linear color, then apply master intensity and blackout in a final full-canvas pass. Depth is disabled and clear/layer order is fixed. Test blackout with opaque video playing.
- Track transition uses current behavior `min(2 seconds, 2 beats)`; Live transition uses 1.5 seconds.
- Baked clips need one video element. A transition decodes at most incoming and outgoing clips.
- If video time does not advance for 500 ms, fade to poster, then gradient if recovery fails. Correct small drift with playback rate up to +/-5%; hard seek only above 1 second.
- On `webglcontextlost`, show CSS safe color; restore textures from cache. Adaptive resolution affects gradient only, not the plate.

For baked clip duration `D`, Track media time is `mod(max(0, position-sectionStart), D)`. Live accumulates `liveMediaSec += deltaSec` and uses `mod(liveMediaSec,D)`. Pause freezes. Seek waits for `seeked`/a decoded frame before poster-to-video fade. Stop resets to zero/poster. A new Live cue resets; Previous restores saved time. Mode change starts destination at zero unless Resume is chosen. Late Track join computes from synchronized state; Live receives accumulated media time. Rejected autoplay stays on poster/gradient until local Arm succeeds.

For `loopMode:none`, the clip plays once, then holds its poster/end-frame until the section changes. Camera `pingpong` uses period `2 * lastKeyBeat`: forward to the last key, then reverse without duplicating endpoint frames. If a new cue interrupts a transition, choose the currently dominant clip at alpha 0.5, stop/release the other decoder, and start the new transition from that dominant clip. This may shorten a fade but never allocates a third decoder.

### 6.3 Camera choreography

`camera.js` is pure and maps beat-relative keys to a clamped UV crop. UI: camera lane, Add key, beat-snapped drag (Alt for free), click focus, scroll zoom.

Track beat: `(positionSec-sectionStartSec) * trackBpm / 60`. Live accumulates `liveBeat += deltaSec * currentBpm / 60`, so tap-tempo changes do not jump the camera. Optional cue quantize schedules GO on the next bar.

Camera zoom is clamped to `1.0..3.0`. Keys sort by beat; for duplicates, the last edited key wins. Before the first and after the last key, the nearest key holds. Defaults use tuples `(section fraction,x,y,zoom)` with image-space `y=0` at the top. Fractions compress across short sections rather than dropping keys.

| Move | Ordered default tuples |
|---|---|
| static | `(0,.50,.50,1.00)`, `(1,.50,.50,1.00)` |
| push-in | `(0,.50,.50,1.00)`, `(1,.50,.50,1.45)` |
| pull-out | `(0,.50,.50,1.45)`, `(1,.50,.50,1.00)` |
| pan-left | `(0,.65,.50,1.30)`, `(1,.35,.50,1.30)` |
| pan-right | `(0,.35,.50,1.30)`, `(1,.65,.50,1.30)` |
| tilt-up | `(0,.50,.65,1.30)`, `(1,.50,.35,1.30)` |
| tilt-down | `(0,.50,.35,1.30)`, `(1,.50,.65,1.30)` |
| rise | `(0,.50,.65,1.25)`, `(1,.50,.40,1.00)` |
| fall | `(0,.50,.35,1.00)`, `(1,.50,.60,1.25)` |
| dolly-through | `(0,.50,.50,1.00)`, `(1,.50,.50,1.70)` |
| drift | `(0,.38,.62,1.10)`, `(.5,.50,.50,1.15)`, `(1,.62,.38,1.10)` |
| orbit | `(0,.50,.32,1.25)`, `(.25,.68,.50,1.25)`, `(.5,.50,.68,1.25)`, `(.75,.32,.50,1.25)`, `(1,.50,.32,1.25)` |

Free-text `camera.from/to` are labels only; v2 does not pretend to locate named subjects. Defaults span the section or requested bars, whichever is shorter.

## 7. Publish, READY, and show failures

Studio edits draft; show reads a published manifest only.

1. Core validates references, hashes dependencies, and atomically writes immutable manifest revision.
2. Publish is disabled during Track playback. Live publish creates a pending revision that cannot activate until outputs prepare it.
3. Show caches every manifest dependency in Service Worker Cache Storage, retaining the previous complete revision.
4. Show sends `{t:"output-ready", rev, manifestHash, failures:[]}` separately from `hello`.

Each publish creates one immutable `publishRevision`. That exact identifier is used by the manifest path, `preparedRevision`, `activeRevision`, show state, and cues. `stateRevision` only identifies its source draft; `manifestHash` is integrity data, not identity.

The manifest contains `publishRevision`, `schemaVersion`, `stateRevision`, scene, section order, and a complete `dependencies` array. Every dependency records immutable URL, SHA-256, byte size, MIME, and cache role (`shell-html`, `script`, `style`, `module`, `audio`, `image`, `poster`, `video`, or `runtime-data`). It includes the exact offline app build, not merely an `appBuildHash`. Published dependencies are content-addressed and protected from garbage collection while any retained manifest references them. A cache revision commits only after all dependencies verify and the app declares schema compatibility.

Service Workers require a secure origin. M2 therefore provisions trusted HTTPS/WSS on a stable venue hostname such as `stagegen.local`: generate a private local CA/server certificate, install/trust that CA on each paired show laptop during setup, and verify hostname resolution without internet. There is no promise of reload-while-server-down on plain LAN HTTP. M2 cannot pass until Service Worker registration succeeds from the actual show URL on every target laptop.

Preparation and activation use prepare/commit/abort. Studio selects required stable output IDs. Each output reports `preparedRevision` as READY or DEGRADED while continuing `activeRevision`. Core issues `commit-activation(publishRevision, activateAtServerMs)` only after every required output prepared the same hash and ACKed that future switch time. Missing ACK before cutoff causes `abort-activation`; nobody switches. After commit, outputs switch locally and ACK `activeRevision`. Cues carry `publishRevision`; mismatched outputs ignore them.

Network atomicity cannot be guaranteed after commit. If post-switch heartbeats disagree, transport enters `ACTIVATION_FAULT` and ordinary cues stop. Operator chooses synchronized rollback to the previous cached revision, explicitly removes the failed output, or triggers Safe look/Blackout. DEGRADED override may accept named media fallbacks but never a hash/revision mismatch. Silence is never consent.

```text
DISCONNECTED -> SYNCING -> VERIFYING -> READY
                      \-> DEGRADED
new revision -> STALE (keep old revision) -> SYNCING
```

READY requires matching hashes, image decode/GPU upload, video first-frame decode, and one rendered test frame per referenced section. DEGRADED means cached revision with named poster/gradient fallbacks. Panic commands always work; normal Play warns and requires second confirmation if any output is not READY.

Every two seconds, outputs report revision/hash, fps, visibility, fullscreen, decoder stalls, and fallback. Studio marks stale/mismatched outputs red. Track extrapolation uses the synchronized server clock derived from `performance.timeOrigin + performance.now()`: cross-output position spread <=50 ms is READY, 50-100 ms warns, and >100 ms marks the output DEGRADED until resynchronized.

Core atomically persists `{activeRevision, mode, playing, sectionUid, trackPositionSec, liveBeat, liveMediaSec, bpm, cueSeq, bootId, persistedAtUnixMs}` after each cue. Outputs checkpoint the same transport plus their local monotonic sample to IndexedDB every second. On WS loss, Track extrapolates locally and Live continues its accumulated section. After a core restart, core enters `RECOVERY_HOLD`; outputs report checkpoints, no new transport state is pushed, and the operator chooses the leader checkpoint or persisted server state. Core then rebases a new process-local anchor and sends an explicit resume cue. A new boot never auto-applies default/backward state.

Local/studio panic controls: Blackout, Layers off, Freeze, Previous cue, Safe look. Blackout is a latched DOM/CSS top-layer override independent of WebGL and survives context loss/reload. Layers off and Safe look are also latched local output state; Freeze holds the last rendered frame/poster. Normal server cues cannot clear a latch. Clearing requires an explicit authenticated Clear Panic command or local operator gesture. Exported loops/cue sheet are the independent backup if server and web control fail.

## 8. Automated generation and spending

Generation starts only after import/compositor/camera/show reliability pass on target hardware.

1. Studio gets a curated catalog and operator-verified price estimates.
2. Operator chooses section/model/count/duration and confirms the maximum estimate.
3. Core authorizes and forwards sanitized IDs, never absolute output paths, to loopback gateway.
4. The account-wide gateway database uses one SQLite transaction to reserve budget, pin the source asset content hash/revision, and create one job per output. A client request ID and payload hash make identical retries return the original batch; key reuse with a different payload is rejected. This lookup happens before rejecting a now-stale `baseRevision`.
5. Gateway submits, stores remote task ID, polls, downloads temporary results immediately, normalizes, then writes a durable outbox event. It does not edit core asset metadata.
6. Image-to-video requires an approved local still and records the remote upload URL only in its job row.

```text
queued -> submitting -> provider-running -> provider-succeeded -> downloading -> normalizing -> done
                 \-> provider-failed                 \-> processing-failed
queued/running -> abandoned
ambiguous submit without remote ID -> unknown
```

Queued may dispatch once. A stored remote ID resumes polling, never resubmits. Any timeout, reset, crash, or ambiguous response after request bytes may have reached the provider goes to `unknown`, never automatic retry. Download/normalize resumes from recorded temp metadata. Provider outcome, local processing outcome, and billing settlement are separate columns: provider success settles spending even if download/normalization fails; provider-declared failure releases it; uncertain outcome keeps it reserved. Abandonment/reconciliation is defined for every nonterminal state and never erases financial history.

Transitions are conditional on current state and `attemptId`. The transactional outbox retries `{projectId,jobId,attemptId,sequence}` with per-boot secret until core acknowledges. Core idempotently adopts a successful result by job/attempt into a new state snapshot; if its analysis/source revision is stale, it adds the asset unassigned and never activates it. Core acknowledges only after commit. Duplicate/out-of-order events are ignored. Temp/orphan cleanup is explicit.

Each curated model has explicit endpoint family, label, exact provider slug/taskModel, fixed inputs, aspect/resolution rules, duration type, image parameter, request builder, and response parser. Fixtures assert exact requests/responses. There is no fallback or silent model substitution. The checked-in Open Higgsfield client is evidence, not proof of live behavior; run one manual contract smoke test.

Unsupported target aspect shows the selected nearest aspect and later cover crop. Duration uses that model's range or discrete list. A style-reference still is offered only if the selected model explicitly supports it.

Budget rules:

- Soft project and hard account budgets use an operator-verified price per image/per video second with `priceCheckedAt`. Unknown-price models stay disabled.
- Confirmation shows outputs, duration, maximum estimate, spent, reserved, and remaining.
- Reserve and create jobs atomically. Provider-declared failure releases; success spends; timeout/abandoned/unknown stays reserved until reconciled.
- Count is 1-4; model duration and global/per-model concurrency are server-bounded.
- No automatic whole-song generation in v2.

## 9. API additions and trust boundaries

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/projects/<id>/assets/import` | Stream validated local import |
| GET/PATCH/DELETE | `/api/projects/<id>/assets[/<assetId>]` | List, approve, reject, activate, remove if unreferenced |
| GET/PUT | `/api/projects/<id>/scene/draft` | Revision-checked draft mutation |
| POST | `/api/projects/<id>/publish` | Immutable manifest revision |
| POST | `/api/projects/<id>/sections/commands` | Revision-checked rename/move/split/merge |
| GET | `/api/models/generation` | Sanitized model and price metadata |
| POST | `/api/projects/<id>/generate` | Idempotent paid batch after atomic budget check |
| GET/POST | `/api/projects/<id>/jobs`, `.../<jobId>/abandon` | Job state/local stop |
| GET | `/media/<id>/assets/<generatedName>` | Same-origin media with byte ranges |

Show uses fully cached responses/Blob URLs. HTTP Range remains for studio seeking and partial-cache recovery.

Mutations require operator session, same origin, valid project IDs, `baseRevision`, bounds, enums, and reference ownership. Show tokens can only read and send scoped health/readiness. Internal calls require loopback plus secret. Remote downloads allow only HTTPS public provider hosts, revalidate redirects, block private/link-local targets, and enforce byte/dimension/duration/time/disk/concurrency limits.

## 10. Implementation order and gates

### M0 - safety, identity, import (medium)

- Operator/show authorization, immutable state snapshots, base-revision concurrency, UID migration, import/normalization, asset library.
- Extract existing C++ only where changed routes require it; no style-only refactor.

Gate: stale/concurrent writes cannot lose data; LAN show cannot mutate; imported still/video can be approved and activated without paid services.

### M1 - compositor and camera (medium)

- Textured plate, final blackout, UV camera, all 12 defaults, deterministic transport, transitions and fallbacks.

Gate: requested detail-to-detail pan works at 16:9 and real LED aspect; blackout hides opaque video.

### M2 - publish/show hardening (large)

- Trusted local HTTPS/WSS, complete content-addressed manifests, prepared/active revision protocol, Service Worker cache, READY, decoder/GPU recovery, transport reconciliation, heartbeat, latched panic controls, backup export.

Gate: secure-origin Service Worker registration on every real output, then two rehearsals including core kill/reconciliation, LAN pull, server-down tab reload, context loss, wrong cue recovery, tempo change, and latched blackout.

### M3 - generation backend (large)

- SQLite job/budget journal, exact kie adapters, upload, resume/reconcile, bounded download, baked loop, mock provider.

Gate: mocks cover exact contracts, all crash states, duplicate requests/events, provider fail/timeout/unknown, then one approved real still and shortest video.

### M4 - generation UI (medium)

- Candidates, approve/activate, animate, cost confirmation, style reference, progress/errors/reconciliation.

Gate: generated media follows the same camera/publish/cache/fallback path as imports.

### M5 - section editing/polish (medium)

- Explicit section commands/invariants. Add blend modes only after hardware performance passes.

Gate: edits preserve published revisions and pass every invariant in section 5.

## 11. Verification and done

- Unit: migrations/snapshots, section commands, camera crop/easing, Live beat/media accumulation, manifests, job transitions, atomic budgets.
- Integration: operator/show auth, concurrent/stale mutations, malicious uploads, SSRF/redirects, ffmpeg failure, exact model fixtures, ambiguous submit at each network phase, provider-success/local-failure billing, outbox retry/adoption, account-wide concurrent budgets, ranges, secure-origin Service Worker rollback.
- E2E with assertions: import -> activate -> camera -> publish -> READY; generate -> activate -> publish; ordinary autoplay/Arm; Track/Live transport; heartbeat; panic; opaque-video blackout; corrupt/missing media fallback.
- Test 1920x1080 plus actual LED canvas. Target laptop sustains at least 50 fps through a two-video transition.
- Run 60 minutes without black frame, uncaught error, or unrecovered stall.
- Disconnect internet on wired LAN; then separately stop core, pull LAN, reload tab, change tempo, cue wrong section, and restore WebGL context.
- Backup player opens exported loops and cue sheet.

Pass thresholds: cached reload reaches the active manifest within 10 seconds; core restart reconnects within 10 seconds with no backward jump over 100 ms; cue spread stays <=50 ms; decoder/GPU failure reaches poster or gradient within 1 second; blackout yields a black final frame on the next rendered frame.

v2 is done when an operator can import or generate a plate, choreograph it, publish it, and complete the real-hardware rehearsal/failure matrix.

## 12. EGM review log

### Comprehension Goldfish - NEEDS REDRAFT on v1

Resolved: mapped all camera moves; made free-text labels non-semantic; specified transitions, Track/Live timing, Range, easing/loop fields, READY, activation, split/merge, keys, job states, aspects, and acceptance targets.

### Live-show reliability Goldfish - major recut accepted

Accepted: immutable publish, Service Worker cache, persisted cues/boot ID, render-tested READY, baked loops, watchdog, accumulated Live beats, UID cues, panic controls, context recovery, heartbeat, realistic limits, chaos tests, and independent backup export.

### Cost/product Goldfish - major recut accepted

Accepted: Import/compositor/camera before paid automation; no gating refactor/editor; 2D crop; baked loops; gateway-owned jobs; conditional style reference; deferred extras; price-based atomic budgets.

### Hostile technical Goldfish - NEEDS REDRAFT on v1

Resolved in v3: authenticated scoped roles; transactional immutable snapshots; explicit section commands; revision-bound async results/audio policy; idempotent atomic jobs/budgets; attempt/sequence transitions; exact provider contracts without fallback; approval versus activation/deletion guards; deterministic media time; revision-specific READY; final-composite blackout; upload/download/ffmpeg trust limits.

### Final implementation-readiness Goldfish

Round 1 verdict: **NEEDS REDRAFT**. Resolved in v4: trusted HTTPS/WSS for LAN Service Workers; complete content-addressed manifest including audio/app/schema; prepared versus active revisions and revision-tagged cues; checkpoint/recovery transport and latched DOM blackout; account-wide retained financial journal; durable source pins and transactional outbox adoption; separate provider/processing/billing states for every ambiguous submit; and explicit non-loop, ping-pong, and interrupted-transition behavior.

Round 2 verdict: **GO WITH CHANGES**. Resolved: secure-origin deployment, one account-wide atomic ledger, M0 loop ownership, explicit output activation/reboot reconciliation, hard import ceilings, transactional outbox adoption, numeric camera presets, camera edge semantics, clock tolerances, and measurable rehearsal thresholds.

Final cold check found one regression: the crash-safe staging rewrite had dropped the concrete browser playback normalization profile. v5 restores JPEG/PNG image limits and H.264 High/yuv420p/no-audio/`+faststart` video with poster for both imports and generated results. No other blocker was found. Final verdict: **CONDITIONAL GO**, subject only to the owner decisions below and the bounded TLS, provider-contract, and real-hardware gates in sections 10-13.

## 13. Owner decisions before implementation

1. Target show laptop CPU/GPU/RAM/browser and output count.
2. Actual LED resolution/aspect; default is 16:9 until supplied.
3. Whether kie.ai exposes balance/pricing API or needs operator-maintained estimates.
4. Initial soft project and hard account budgets.
5. Preferred default video model after one real smoke test.
6. Whether visuals are for public/paid events, so commercial-use terms can be checked per enabled model.
