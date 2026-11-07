# Stagegen

AI-generated, audio-synced background visuals for live shows. Upload a track, describe the vibe, and the AI turns it into a visual plan fitted to that track: a palette, a look, and image/video generation prompts for every section. The visuals play fullscreen on a show laptop, in sync with the music.

See [SPEC.md](SPEC.md) for the full design and roadmap.

## Run it (server laptop, Windows)

Requirements: Node.js 20+, ffmpeg on PATH, CMake, and Visual Studio 2022 Build Tools (C++).

```
start.cmd
```

The first run builds everything (C++ core, web UI, gateway deps), then opens the studio at **http://localhost:8080**.

1. **Drop an audio file** on the timeline. It is analyzed for BPM, beats, bars, key, and sections, which takes about a second.
2. **Settings (⚙)**: add an **OpenRouter** key (any model, including Claude) or an **Anthropic API** key. Keys are DPAPI-encrypted on this laptop.
3. **Prompt bar**: describe the visuals, then click **Refine for this track**. The plan appears on the right, where every prompt, palette, camera move, and look setting can be edited.
4. **Show output ↗**: open the listed `http://<lan-ip>:8080/show/<id>` URL on the show laptop and click **Start output**.

Run the studio at `localhost` on the server laptop. Browsers only allow live audio input on `localhost` or HTTPS pages.
If the show laptop can't connect, allow `stagegen.exe` through Windows Firewall (private networks).

## Show modes

| | **Track** | **Live** |
|---|---|---|
| Timing | Follows the uploaded track's timeline (server clock) | Operator cues sections (pads, ←/→, 1–9) |
| Reactivity | Pre-analyzed bands, beats, downbeats | Live input (mixer or mic on the server laptop) relayed to outputs, plus tap tempo / BPM |
| Audio | Monitor on the studio and/or on the show laptop (**Audio on show**) | n/a |

Both modes share **Intensity**, **Blackout (B)**, and **Offset** (delay the visuals to match projector or PA latency).

## Any screen

The output fills whatever window it's in (16:9, 4:3, portrait, ultra-wide LED). Rendering resolution adapts to keep the frame rate up. For fixed pixel maps:
`/show/<id>?res=3840x1080&fit=contain|cover|stretch&scale=0.75&hud=1` (`H` toggles the info overlay, `F` toggles fullscreen).

## Layout

```
core/      C++20 server (Crow + asio): HTTP/WebSocket, audio analysis, show clock & cues, DPAPI key store
gateway/   Node sidecar: LLM prompt refinement (OpenRouter / Anthropic SDK, structured output)
web/       Vite + Three.js + GLSL: studio (index.html) and show output (show.html)
tests/     Playwright end-to-end check (screenshots + sync measurement)
_ref/      Open-Higgsfield-AI clone (Autom8AI fork), the reference for the v2 generation client
data/      Runtime: projects, settings, encrypted secrets (git-ignored)
```

Development: run `stagegen.exe`, then `npm run dev` in `web/` for hot reload on :5173 (it proxies the API and WebSocket to :8080).
