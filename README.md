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

## CLI

The floor is **stitch the clips into one video**; a telemetry **dashboard** is added
on top when the footage carries GPS (embedded or a sidecar `.gpx`).

Not published to npm yet — clone it and run the CLI straight out of the checkout with
`npx` (no global install, no `npm link` needed):

```bash
git clone https://github.com/zordius/movie-layers.git
cd movie-layers && npm install

npx movie-layers GX065132.MP4                    # → GX065132-overlay.mp4 (GoPro auto-dashboard)
npx movie-layers ./ride-folder                   # concat every clip in the folder (sorted)
npx movie-layers GH010001.MP4 GH020001.MP4       # concat two clips into one timeline
npx movie-layers clip.mp4 --gpx ride.gpx         # telemetry from a sidecar .gpx
npx movie-layers GX065132.MP4 --map              # OpenStreetMap basemap under the track map
npx movie-layers plain.mp4                       # no GPS → just stitch/encode (no dashboard)
npx movie-layers clip.mp4 --snapshot --at 30 --open  # preview PNG at 30 s, then open it
```

`npx` finds `movie-layers` from the clone's own `package.json` — nothing to publish or
install globally. Want a bare `movie-layers` command instead of the `npx` prefix? Run
`npm link` (or `npm install -g .`) once from the clone.

Inputs are clips and/or directories (a directory expands to its videos, sorted);
several inputs concat into one timeline (same resolution / fps), telemetry
offset-merged across the join. A clip with **no GPS and no `--gpx`** isn't an error —
it's stitched/encoded as-is (with just the date/time readout if the clip has a
clock). `--snapshot` (optionally `--at SEC`, default the middle) writes one PNG with
the overlay composited over that frame — a fast preview without encoding the video.
The CLI logs each stage: inputs probed, telemetry found, widgets, render progress,
and the result with its value ranges.

The dashboard is authored in a 1080-tall **logical** space and the engine's
`scaleBaseline` normalizes it, so the gadgets sit at the same relative position at
any resolution (1080p, 2.7K, 4K) — not just 1080p. The layout is aspect-aware: a
landscape clip (16:9 / 4:3) gets a bottom row of gauges, a portrait / vertical clip
stacks them in a left column so nothing overflows. Gauge values are smoothed by
default (a critically-damped follow, so needles glide instead of snapping to noisy
GPS); `--no-smooth` turns it off. `--help` lists every flag.

## Library API

`movie-layers` is also usable as a Node library — write your own `Layer` /
`Provider` and drive the `Engine` directly:

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

Run the bundled demo (from the same clone + `npm install` as above):

```bash
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
for the design and a per-feature ✅/🔜 breakdown; gauge behaviour (display
smoothing, derived speed) is in [`docs/dashboard-spec.md`](docs/dashboard-spec.md).

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
- [x] CLI: `movie-layers <video|dir> [...]` → stitch + overlay; directory input,
      multi-clip concat, GoPro auto-dashboard (GPS cleaned + elevation-smoothed by
      default for a stable gradient), no-GPS pass-through (stitch only), aspect-aware
      layout + `--flip`, `--snapshot` PNG preview, staged logging + ETA, `--open`,
      `--quiet`, `--gpx` / `--clock-offset` / `--no-stabilize` flags
- [x] Dashboard presentation: per-gauge display smoothing (default-on,
      `--no-smooth`) + GPS-derived `speed` fallback (when device speed is absent) —
      see [`docs/dashboard-spec.md`](docs/dashboard-spec.md)
- [x] `provider-map`: optional OpenStreetMap basemap under the big track map
      (`--map`, off by default), projected with the track's own fit so it stays to
      scale; tiles fetched once and disk-cached (`--map-cache`, default
      `~/.cache/movie-layers/tiles`; `--map-zoom` overrides the auto fit). The
      track's small follow-circle inset keeps its own view (no basemap)
- [x] Encode + render speed: detection-based hardware-encoder **auto-upgrade**
      (videotoolbox / nvenc / qsv / amf — `--no-hw` forces software, explicit
      `--profile` overrides), ffmpeg `--profile` (built-in + user JSON), **`--jobs N`**
      parallel-chunk render with lossless concat (a warm-up overlap keeps gauge
      smoothing seamless across seams), `--range START,END` sub-clip render (each side
      is plain seconds or clock time, e.g. `1:23,2:00`), and
      `--widget-fps` (overlay draw rate, independent of output `--fps`)

Planned:

- [ ] Sidecar `.fit` UTC alignment (binary FIT decoder — `.gpx` is done)
- [ ] Perf: `toBuffer('raw')` + `bgra` (premultiplied) fast path; DoubleBuffer-style
      writer to overlap draw with the pipe write
- [ ] Layout loader (declarative document → layers)

## License

GPL-3.0-or-later — it derives design from the GPL'd `gopro-dashboard-overlay`.
Attribution: original by James Richardson / time4tea.
