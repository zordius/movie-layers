# Data & Timeline Architecture — Spec

How movie-layers gets time-varying data into layers, and how it resolves time
across one or many source videos. Captures the design converged on in design
discussion; marks what's implemented (✅) vs planned (🔜).

---

## 0. Principles

- **`data = time-varying`.** Anything that changes over time and is queryable at
  `t` is *data* (channels). Constants are *config*; heavy constant assets
  (tiles, fonts) are *resources*. (Container metadata like size/fps/duration is
  config, not data — so it is **not** a data provider.)
- **Providers produce; the engine adjudicates.** A provider turns a source into
  channels (+ optional clock evidence). All cross-cutting resolution — timeline,
  clock, channel merge — is the engine's, because only the engine has the whole
  picture (segment list, order, durations, all providers' outputs).
- **Collected up front.** Every provider's `load()` runs once before the render
  loop; the loop only does in-memory lookups. Where the bytes come from
  (inside the video vs a separate file) makes **no** lifecycle difference.
- **Dependencies point inward.** `movie-layers` core depends on nothing;
  providers depend on core's contract. Telemetry extraction/smoothing lives in a
  separate render-agnostic package (`telemetry-core`); a provider adapts it.

---

## 1. Provider model — one abstraction, two optional facets

A provider is `{ name, data?, layers? }`. At least one facet. ✅

```js
defineProvider({
  name: 'gopro',
  data:   async ({ sources, config }) => ({ channels, clock? }),   // optional
  layers: { 'speed': { needs: ['speed'], create } },               // optional
})
```

- **Pure layer pack** = `{ name, layers }` (e.g. `provider-svg`). ✅
- **Pure data pack** = `{ name, data }` (e.g. a GPX reader). ✅ (via
  `defineDataProvider` today)
- **Both** = `{ name, data, layers }` (e.g. `provider-gopro`: telemetry channels
  + dashboard widgets shipped together). ✅ (shape demonstrated in the example;
  `provider-gopro` itself pends `telemetry-core`)

Engine consumes a single `providers: [...]` array and routes by facet. ✅
(`dataProviders` kept as a back-compat alias.)

There is **no** "embedded provider" vs "sidecar provider" type. The only
variable is what `load()` reads from — see §3.

### Object vs factory, and where parameters go

The engine's input is always a **provider object** (`{ name, data?, layers? }`).
How you obtain it depends on whether the provider needs construction config:

- **Ready-made** (no provider-level config) → the package exports the object;
  use it directly: `providers: [svg]` (no `()`).
- **Configurable** (needs e.g. a sidecar file or options) → the package exports a
  **factory** `(config) => provider`; call it to bind config:
  `providers: [gpx({ file: 'ride.gpx' })]`.

A factory is just "a function returning a provider object"; whether you write
`()` reflects whether the provider needs config — a useful signal, not an
inconsistency.

**Two parameter locations:**

| parameter | where | example |
|---|---|---|
| per-layer instance (appearance / behaviour) | the **layout** entry `{ type, ...config }` | `svg`'s `src` / `x` / `y` / `render` |
| provider-wide (esp. a sidecar data source) | **provider construction** (factory args) | `gpx({ file })` |

So `svg` is ready-made (no provider-level config — its params live per-layer in
the layout); `gpx` is a factory (binds its sidecar file); an embedded provider
like `gopro` (reads the engine's base video, no file to bind) is typically
ready-made too.

**Convention:** export a **factory** iff the provider needs construction config;
otherwise export the **object**.

---

## 2. Data model ✅

`data.load()` returns named channels:

```js
{ channels: { speed: { unit: 'km/h', samples: [{ t, value }] }, ... },
  timeRange?: [t0, t1],
  clock?: { startUtc, confidence, verified },     // optional per-source clock evidence, §5
  timezone?: 'Asia/Tokyo' }                        // optional constant tz candidate (e.g. GPS→tz), §5
```

- `t` is seconds on the **global playback timeline** (engine applies segment
  offsets, §4).
- `value` may be `number`, `number[]`, or `{numeric}` (e.g. `{lat,lon}`).

Engine merges channels into a `DataSet` and exposes per frame a time-bound
accessor `frame.data`:

| call | returns |
|---|---|
| `get(name)` | value interpolated at `frame.timeSec` (binary-search + linear; clamps at ends; non-numeric holds nearest) ✅ |
| `series(name)` | whole sample array (for paths/charts) ✅ |
| `stats(name)` | `{min,max,avg,count}` over the series ✅ |
| `unit(name)` | the channel's unit string ✅ |
| `has(name)` | channel present? ✅ |

Layers declare `needs: [channel]`; the engine fails fast before rendering if a
need is unmet. ✅

---

## 3. Source model — `load({ sources, config })`

One signature; embedded vs sidecar is just which input `load` uses. ✅

- **`sources`** — the engine's base-video segments (see §4), each a handle:
  `{ file, offset, duration, startUtc, bytes(streamTag) }`. A provider reading
  data embedded **in the video** uses these. The engine is the **only** owner of
  the video file list, so embedded providers never name a file themselves.
- **`config`** — the provider's own bound options. A provider reading an
  **external sidecar file** (Garmin `.gpx`/`.fit`) is parameterized at
  construction (`gpx({ file: 'ride.gpx' })`) and reads its own path.

Time alignment differs (but both happen up front):

| | bytes from | sample-time → global clock |
|---|---|---|
| in-video | engine `sources` | structural: add segment `offset` |
| sidecar | own bound file | absolute UTC: match against segment `startUtc` anchors |

**Shared `Source` ✅.** The base video is probed **once** (cheap, format-
agnostic ffprobe) and shared with the engine and every provider; per-stream
*extraction* (`bytes('gpmd')`) is cached. So "does this video have GPS?" is a
lookup on the shared probe, not a re-read. Core reads container fields; each
provider does only its own format-specific extraction.

---

## 4. Segment timeline — multi-file (single file = N=1)

The engine owns a list of segments. Each segment descriptor:

```js
{ file: 'GH020001.MP4',  // full path (engine-owned list)
  offset: 120,           // playback position in the OUTPUT timeline, seconds
                         //   = cumulative duration of prior segments (gaps NOT counted)
  duration: 95,
  startUtc: <epoch ms>,  // wall-clock anchor for THIS segment (§5)
  // sourceInPoint: 0    // 🔜 only when trimming a segment; whole-file concat = 0
}
```

**Two clocks** (✅ in `Timeline`):

- **Playback clock** — `timeSec`/`progress`, continuous across segments
  (`offset` accumulates durations only). Drives rendering/animation; never jumps.
- **Wall clock** — `dateTime = segment.startUtc + segment.localTimeSec`. Per
  segment; **may jump** across a real-world gap. Drives "what time was it".

The video stream itself is handled **only by ffmpeg** (concat demuxer presents N
files as one logical `[0:v]`; max 1 logical base input; `[0:v][1:v]overlay`). The
engine never touches video pixels. ✅ (per-segment probe, cumulative offsets,
per-segment `creation_time` anchors, concat list builder, dimension guard)

**Invocation.** The engine hands each provider the full `sources` list ✅.
Applying each segment's `offset` when merging a provider's samples onto the
global timeline is 🔜 (no embedded provider exists yet); sidecar UTC alignment 🔜.

---

## 5. Clock resolution (engine) — structural ✅, GPS/continue/gap 🔜

Each segment's `startUtc` is resolved by the engine from candidate anchors. The
**structural** part is done: explicit `startUtc` else the segment's
`creation_time`. The GPS-candidate / continue-time / gap / confidence machinery
below is 🔜 (needs `provider-gopro`).

### Precedence (per segment)
```
GPS (verified)  >  container creation_time  >  file mtime (untrusted)  >  none
```

- **GPS** — only the data provider can derive it (back-calc from the gpmd GPS
  samples). It is a *candidate*, reported to the engine as
  `clock: { startUtc, confidence:'gps', verified }`. "GPS" means **first good fix**
  (3D, low DOP, valid GPSU); robustness via **linear regression of UTC vs
  media-offset, slope ≈ 1**. Fails the quality gate → fall through.
- **creation_time** — from the engine's probe. Camera clock; may be wrong.
- **mtime** — often the copy/move time, not the recording time → **treat as
  untrusted**; prefer `dateTime = null` over showing a wrong date.
- Each resolved segment carries `confidence: 'gps'|'meta'|'file'|'none'`.

### Candidates → engine adjudicates
```
candidates per segment:  GPS (from provider) · creation_time (probe) · mtime (fs)
engine:
  1) pick highest-confidence candidate per segment
  2) continue-time: fill weak/missing segments from a reliable neighbour
                    (neighbour.startUtc + neighbour.duration)        ← cross-segment ⇒ engine
  3) gap detection: assert a gap ONLY between two INDEPENDENT high-confidence
                    anchors whose delta disagrees with cumulative duration
```

### continue-time × gap (the v3→v4 case)
If `v4` has no GPS, the engine **continues** `v3`'s GPS anchor (`v3.startUtc +
v3.duration`) → `v3→v4` is seamless. Because `v4`'s anchor is *derived* (not an
independent reading), gap detection does **not** fire — which is the desired
behaviour.

### Best-clock-wins (sidecar better than video)
When the video clock is weak (mtime/none) but a sidecar (Garmin GPX) has
authoritative GPS UTC, do **not** force the sidecar onto the bad video clock —
let the best available clock be the reference and anchor the video to it.

> Playback `offset` is independent of all this: it is always known, so rendering
> never breaks when the wall clock is unknown — only `dateTime` degrades to null.

### Timezone

`frame.timezone` is **config (constant), not a channel** — one IANA tz for the
render, used only to *display* the absolute `dateTime`. A data provider may
derive it (e.g. GPS lat/lon → tz, logic owned by an external lib) and report it
as a constant `timezone` in its `load()` result; the engine adjudicates (provider
proposes a candidate, engine decides — a fetched value never dictates):

```
explicit Engine({ timezone })  >  provider-derived (e.g. GPS)  >  default (null → UTC at display)
```

Resolved once before the loop (provider `load()` runs up front). Per-segment tz
(cross-timezone travel) is a future extension, mirroring per-segment `startUtc`;
today it is one global value. ✅ engine resolution · 🔜 GPS→tz derivation (provider).

---

## 6. Channel merge (engine) ✅

Multiple providers may supply the **same** channel (GoPro's own GPS *and* a
Garmin GPX `gps`). `DataSet.addChannel` overwrites; `DataSet.load` resolves
conflicts via `channelMerge` (mirrors the Python `--gpx-merge OVERWRITE`):

```js
new Engine({
  providers: [gopro, gpx({ file: 'ride.gpx' })],
  channelMerge: { gps: 'gpx' },   // on conflict, gps comes from gpx; default = last wins
})
```

---

## 7. Division of labour

| concern | owner |
|---|---|
| parse a source → channels | **provider** |
| derive GPS clock candidate (back-calc) | **provider** (only it knows the format) |
| derive timezone (GPS → tz) | **provider** (external lib) |
| segment list / file paths | **engine** |
| probe (shared `Source`) / container config | **engine** |
| apply segment offsets, merge to global timeline | **engine** |
| clock precedence + continue-time + gap + confidence | **engine** |
| resolve `frame.timezone` (explicit > provider > default) | **engine** |
| channel-conflict merge precedence | **engine** |
| ffmpeg concat + overlay + encode (video pixels) | **ffmpeg** |

---

## 8. Status summary

✅ Implemented: data model + interpolated `frame.data` + `needs` validation;
unified provider facets + single `providers` array; `load({sources,config})` +
shared cached `Source`; `probeVideo` + base-video config resolution; segment-based
two-clock `Timeline`; multi-video concat (per-segment probe, cumulative offsets,
per-segment `creation_time` anchors, concat list builder, dimension guard);
channel-merge precedence; timezone resolution (explicit > provider > default);
`provider-svg`.

🔜 Planned: clock resolution GPS half (GPS candidate → continue-time → gap →
confidence); provider GPS→tz derivation (external lib); embedded-provider data
offset-merge; sidecar UTC alignment;
`sourceInPoint` (segment trimming); provider-private `setup` → shared resources;
perf path (`toBuffer('raw')`/bgra, DoubleBuffer, GPU profiles); `provider-gopro`
(needs `telemetry-core`).
