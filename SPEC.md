# Stagegen — Spec v0.1

AI-generated, audio-synced background visuals for live shows.
Upload a track → refine a prompt against the music → generate assets → choreograph camera moves → play fullscreen behind the artist.

---

## 1. Goals

- Upload an audio file and play it in the browser with waveform + timeline.
- Analyze the track (BPM, beats, bars, sections, energy, mood).
- Prompt bar at the bottom: user writes a rough idea; an LLM refines it **per section of the song**.
- Refined prompts are sent to the generation engine (forked Open Higgsfield) to create assets.
- Assets are composited with audio-reactive GLSL gradient backgrounds in a 3D scene.
- User choreographs **panning / camera moves** (A → B, detail → detail) on a beat-snapped timeline.
- A show laptop opens a URL and gets a clean fullscreen output, driven by the server laptop.
- Works for a single operator first, but the data model supports multiple users (product mode).

## 2. Deployment topology

```
┌──────────────── SERVER LAPTOP ────────────────┐         LAN          ┌──── SHOW LAPTOP ────┐
│                                               │                      │                     │
│  stagegen-core (C++)                          │  HTTP + WebSocket    │  Browser            │
│   • HTTP: serves web app, assets, API         │ ───────────────────► │  /show/<projectId>  │
│   • WebSocket: show control + clock sync      │                      │  Three.js + GLSL    │
│   • Audio analysis (aubio / Essentia)         │                      │  fullscreen → LED / │
│   • Offline MP4 export (OpenGL + GLSL + ffmpeg)│                     │  projector          │
│                                               │                      └─────────────────────┘
│  ai-gateway (Node sidecar)                    │
│   • LLM prompt refinement (OpenRouter /       │       Operator browser (on server laptop
│     Anthropic API)                            │       or any LAN device): /studio
│   • Generation via forked Open Higgsfield     │
│     client (kie.ai)                           │
│   • Job queue, asset download + caching       │
│                                               │
│  storage: SQLite + ./data/projects/<id>/...   │
└───────────────────────────────────────────────┘
```

- **The show laptop has no install.** It opens `http://<server-ip>:8080/show/<projectId>`, which renders in WebGL in its own browser.
- **The show must run without internet.** All generated assets are downloaded and cached on the server laptop before the show. The internet is only needed while generating.
- **The server is the master clock.** The show client syncs its clock to the server over WebSocket (NTP-style ping/offset), and all cues are scheduled in server time.

## 3. Findings: Open Higgsfield fork (`Autom8AI/Open-Higgsfield-AI`)

- Stack: **Vite + vanilla JS + Tailwind** (also contains a Next.js / Electron shell and `packages/studio`).
- It does **not** run models locally. It is a UI over hosted APIs:
  - `src/lib/kie.js`: the primary client for **kie.ai** (`https://api.kie.ai`, Bearer key). It handles `createTask`, polling (`recordInfo`) and Veo endpoints.
  - `src/lib/api.js`: an optional "content-factory" Netlify-functions backend (accounts, credits, Airtable library).
  - The upstream project is powered by Muapi.ai. There are also fal.ai references.
  - `src/lib/models.js`, `videoSpecs.js` and `remixSpecs.js` hold the model catalog and per-model parameter builders. **These are the valuable parts to reuse.**
- **Plan:** Don't embed the whole studio. Port `kie.js`, `models.js`, `videoSpecs.js` and `remixSpecs.js` into the **ai-gateway** sidecar so that:
  - API keys stay on the server (needed for multi-user),
  - the LLM-refined prompts are injected programmatically,
  - results are downloaded into the project's asset cache.
- Optional: mount the forked studio UI at `/studio/advanced` for manual, hands-on generation into the same project library.
- **Cost note:** every generation costs kie.ai credits, so each user or the operator needs a kie.ai key or a credit balance.

## 4. Frontend architecture

- **Renderer: Three.js + custom GLSL (WebGL2).** This is the core, shared by the studio preview and the show output.
- **p5.js:** optional 2D overlay layer and quick sketch prototyping, rendered to a texture and fed into Three.js.
- **cables.gl:** later (v4), as an importable "patch layer" for VJs. Not part of the core pipeline, to avoid running two render engines.
- Pages:
  - `/studio/<projectId>`: waveform/timeline, section lanes, asset bin, keyframe editor, preview canvas, **prompt bar docked at the bottom**.
  - `/show/<projectId>`: chrome-less fullscreen renderer that follows server cues.
  - `/settings`: API keys (OpenRouter / Anthropic / kie.ai), stored server-side and encrypted.

### Scene model

```
Scene
 ├─ Background layer   : GLSL gradient shader (palette from LLM, uniforms ← audio bands / beat)
 ├─ Asset layers[]     : planes at different Z depths, textured with AI images/videos (parallax)
 ├─ FX layers[]        : particles, grain, bloom, chromatic aberration (beat-triggered)
 └─ Camera             : driven by keyframe track (position, target, fov), beat-snapped
```

**Panning = a camera path through layered depth.** "Move from the sun to the figure over 8 bars" becomes two keyframes, each pointing at a focus target on a layer. Easing curves are selectable.

## 5. Backend architecture

### stagegen-core (C++20)
- HTTP + WebSocket: **uWebSockets** (or Drogon).
- Audio analysis: **aubio** (onsets, beats, BPM) and **Essentia** (key, mood/energy, segmentation). Decoding is done with ffmpeg/libav.
- Persistence: SQLite.
- Export: headless **OpenGL 3.3 + the same GLSL shaders** (shared shader source, transpiled between GLSL ES 3.0 and 3.30), with frames piped into **ffmpeg** to produce MP4/ProRes.
- WebSocket channels: `clock.sync`, `show.cue` (play/pause/seek/goto-section), `show.state`, `job.progress`.

### ai-gateway (Node, internal only, called by core)
- Reasons for Node: it reuses the fork's JS code directly, and the LLM and HTTP SDKs are mature there.
- `POST /refine` calls the LLM (OpenRouter or Anthropic API key) and returns the structured plan (§6).
- `POST /generate` submits kie.ai jobs, polls them, downloads the results to `data/projects/<id>/assets/`.
- **Claude subscription plans cannot be used as an app backend.** Use an OpenRouter key (which can route to Claude models) or an Anthropic API key.

## 6. Prompt refinement contract

LLM input: user prompt + analysis summary (BPM, key, sections with energy/mood) + optional lyrics + style references.
LLM output (validated JSON schema):

```json
{
  "palette": ["#0b0f2a", "#ff4d8d", "#ffd36e"],
  "global_style": "cinematic, volumetric haze, 35mm",
  "sections": [
    {
      "name": "intro", "start": 0.0, "end": 22.4, "energy": 0.2,
      "image_prompt": "vast dusk desert, lone silhouette, haze",
      "video_prompt": "slow drift across dunes, dust in backlight",
      "camera_hint": { "move": "push-in", "from": "wide", "to": "silhouette", "bars": 8 },
      "fx": ["grain"], "motion": "low"
    }
  ]
}
```

- `palette` → gradient shader uniforms
- `image_prompt` / `video_prompt` → generation jobs
- `camera_hint` → pre-filled keyframes the user can edit

## 7. Live show sync

- Operator controls: GO / pause / seek / jump-to-section / blackout / per-layer intensity faders.
- Show client: preloads all assets on open, shows a "READY" state, then follows cues.
- Visual timing source (per show, configurable):
  1. **Server playback.** The server laptop plays the backing track and visuals follow it (default).
  2. **Manual cues.** The operator triggers sections live, which suits a performance where the band may stretch or repeat sections.
  3. **Live audio reactivity.** The show laptop listens to the mixer feed through its audio input and drives shader uniforms.
  4. *(later)* MIDI / MTC / LTC timecode input.

## 8. Data model (multi-user ready)

`users` · `api_keys (user_id, provider, encrypted)` · `projects` · `tracks (analysis_json)` · `plans (llm output, versioned)` · `assets (type, source_job, path, section)` · `keyframes` · `shows (project_id, sync_mode)`

Single-operator mode = one local user, no login screen.

## 9. Phases

**Status (2026-11-07): MVP built.** C++ core (Crow) with its own analysis (FFT, spectral-flux onsets, autocorrelation tempo, DP beat tracking, downbeat phase, checkerboard-novelty segmentation, key detection) instead of aubio/Essentia. File-based JSON store instead of SQLite for now. Track + Live sync modes, adaptive any-aspect output, prompt refinement via OpenRouter / Anthropic (`claude-opus-5-5` default).


| Phase | Scope |
|---|---|
| **MVP** | Upload + play audio, waveform; C++ analysis (BPM/beats/sections/energy); audio-reactive GLSL gradient; prompt bar → OpenRouter refinement → JSON plan; `/show` URL synced over WebSocket |
| **v2** | ai-gateway with the ported Open Higgsfield client → per-section image/video generation; layered 3D scene; camera keyframe editor |
| **v3** | Offline MP4 export (C++/OpenGL/ffmpeg); manual cue mode; live audio input; operator faders |
| **v4** | Multi-user accounts + per-user keys; cables.gl patch import; MIDI/timecode |

## 10. Decisions

- Sync: **both** modes. Track mode (server-clock timeline) and Live mode (operator cues + live input), switchable per show.
- Output: **any resolution / aspect ratio**, with optional forced pixel maps for LED processors.
- Server laptop: **Windows** (MSVC + CMake, DPAPI for secrets). The show laptop needs only a browser.
