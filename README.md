# movie-layers

Compose **pluggable layers** into video. A general-purpose engine that draws
every frame on a canvas and pipes it to **ffmpeg** — where the layers come from
**providers** you install or write.

It started as a Node.js reimagining of
[`gopro-dashboard-overlay`](https://github.com/time4tea/gopro-dashboard-overlay)
(Python), but generalised: GoPro telemetry dashboards are just **one provider**.
A pure SVG animation → MP4, a map, or a second clip overlaid on a base video are
all the same shape — **layers** rendered per frame.

## Model

```
provider ──provides──▶ layers ──composited by us──▶ one RGBA frame ──piped──▶ ffmpeg ──▶ MP4
```

- **Layer** — anything that draws pixels at time `t`: a gauge, text, a map, an
  SVG animation. The single unit of composition.
- **Provider** — a module that registers layer factories by `type` string
  (the name used in a layout). Publish them as `movie-layers-provider-*`.
- **Engine** — clears the canvas each frame, draws layers bottom→top, and pipes
  the result to ffmpeg with backpressure.

### ffmpeg: one `overlay`, max one base video

By design ffmpeg only ever does a single composite:

- **base video present** → `[0:v][1:v]overlay` — the base video is always the
  **bottom** layer; everything we draw is the single **top** layer.
- **no base video** → ffmpeg just encodes our frames (pure generated video).

All multi-widget / multi-layer compositing happens in *our* canvas before the
pipe. (Consequence: you can't place a layer *behind* the base video — fine for
overlays/dashboards; out of scope here.)

## Usage

```js
import { Engine, Layer, defineProvider } from 'movie-layers'

class Box extends Layer {
  draw(ctx, { width, height, timeSec }) {
    ctx.fillStyle = '#0a84ff'
    ctx.fillRect((Math.sin(timeSec) * 0.4 + 0.5) * width, height / 2, 160, 160)
  }
}

const provider = defineProvider({ name: 'demo', layers: { box: (cfg) => new Box(cfg) } })

await new Engine({
  width: 1280, height: 720, fps: 30, durationSec: 5,
  background: '#101014', output: 'out.mp4',
  providers: [provider],
  layout: [{ type: 'box' }],
  // baseVideo: 'clip.mp4',   // optional single base video
}).render()
```

Run the bundled demo:

```bash
npm install
npm run example             # basic box demo      → out.mp4
npm run example:svg         # SVG animation layer
npm run example:dashboard   # gopro + dashboard widgets
npm run example:gpx         # sidecar .gpx, UTC-aligned to the timeline
```

## Requirements

- Node ≥ 20 (developed on 26)
- `ffmpeg` on `PATH`
- Renderer: [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) (Skia,
  prebuilt — no system cairo needed)

## Status / roadmap

The ffmpeg seam, layer/provider model, render loop, and the full data & timeline
architecture work. See [`docs/data-timeline-spec.md`](docs/data-timeline-spec.md)
for the design and a per-feature ✅/🔜 breakdown.

Done:

- [x] Data model: interpolated `frame.data` (`get`/`series`/`stats`/`unit`/`has`)
      + `needs` validation
- [x] Providers: `svg`, `gopro` (gps/speed/altitude/gradient channels + GPS→tz
      timezone + per-segment GPS clock candidates), `gpx` (sidecar `.gpx` →
      gps/speed/altitude/gradient, UTC-aligned), `dashboard` (widget layer pack),
      `datetime`
- [x] Segment timeline: two clocks (continuous playback + per-segment wall
      clock), multi-video concat (per-segment probe, cumulative offsets, shared
      `Source`, dimension guard)
- [x] Clock resolution: per-segment pick (explicit > GPS > `creation_time`) +
      continue-time fill + back-derive + gap detection; channel-merge precedence;
      timezone resolution (explicit > provider > default); `clockOffsetSec`
      manual fix for a wrong camera clock

Planned:

- [ ] `provider-map`
- [ ] Sidecar `.fit` UTC alignment (binary FIT decoder — `.gpx` is done);
      `sourceInPoint` (segment trimming)
- [ ] Perf: `toBuffer('raw')` + `bgra` (premultiplied) fast path; DoubleBuffer-style
      writer to overlap draw with the pipe write; GPU ffmpeg profiles (`overlay_cuda`)
- [ ] Layout loader (declarative document → layers)

## License

GPL-3.0-or-later — it derives design from the GPL'd `gopro-dashboard-overlay`.
Attribution: original by James Richardson / time4tea.
