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
- **Both** = `{ name, data, layers }` (one pack shipping telemetry channels +
  widgets together). ✅ shape supported. Today `provider-gopro` is **data-only**
  (gps/speed/altitude/gradient channels, adapting `gpx-stabilizer`) and pairs with
  the separate `dashboard` layer pack; folding the widgets in is optional.

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
need is unmet. ✅ A layer that reads the **wall clock** (not a data channel)
instead declares `needsClock: true` (e.g. the datetime widget) — same fail-fast
contract: if no segment resolves a `startUtc`, the engine throws up front rather
than encoding blank `--:--:--`. ✅

> **Gauge values & smoothing are a separate, presentation-layer concern.** How
> channels become gauge *numbers* and how those numbers are kept visually steady —
> display smoothing (motion, not data), the derived-`speed` fallback, and the
> "derivative tower" principle (most gauges are projections of one 3D position
> signal) — live in [`dashboard-spec.md`](dashboard-spec.md), not here. The data
> layer stays raw; that layer sits on top.

---

## 3. Source model — `load({ sources, segments, config })`

One signature; embedded vs sidecar is just which input `load` uses. ✅

- **`sources`** — the engine's base-video segments (see §4), each a handle:
  `{ file, offset, duration, startUtc, bytes(streamTag) }`. A provider reading
  data embedded **in the video** uses these. The engine is the **only** owner of
  the video file list, so embedded providers never name a file themselves.
- **`segments`** — the full per-segment timeline `{ index, offset, startUtc,
  durationSec }` for **every** segment, *including fileless ones* (`sources` only
  carries file-bearing segments). A **sidecar** provider UTC-aligns against these,
  so a sidecar render works even with no base video. ✅
- **`config`** — the provider's own bound options. A provider reading an
  **external sidecar file** (Garmin `.gpx`/`.fit`) is parameterized at
  construction (`gpx({ file: 'ride.gpx' })`) and reads its own path.

Time alignment differs (but both happen up front):

| | bytes from | sample-time → global clock | status |
|---|---|---|---|
| in-video | engine `sources` | structural: add segment `offset` | ✅ |
| sidecar | own bound file | absolute UTC: `offset + (sampleUtc − startUtc)/1000`, matched against each segment's wall-clock window | ✅ `.gpx` · 🔜 `.fit` |

**Sidecar `.gpx` ✅** (`provider-gpx`, adapting `gpx-stabilizer`'s zero-dep
`readGpx`): each track point's absolute UTC is matched to the segment whose
`[startUtc, startUtc + duration)` window holds it, then placed at `offset +
(sampleUtc − startUtc)/1000`; points outside every window are dropped. Produces
`gps`/`speed`/`altitude` channels and merges via §6. `.fit` (binary) needs its own
decoder — the alignment path is format-agnostic, so a FIT reader drops straight in.
Alignment runs in the engine's **second data round** (two-phase load, §5): the
provider is marked `needsClock: true`, so it loads after clock resolution and
aligns against the best anchors — on a GoPro clip that's the in-video **GPS clock
(true UTC)**, not `creation_time` (a camera clock, often *local* time stamped as
UTC). A sidecar clock overriding a weak *video* clock ("best-clock-wins") remains
out of scope — a sidecar has no `cts` link to the frames (§5).

**Shared `Source` — container probe only.** The base video's container is
probed **once** (cheap, format-agnostic ffprobe) and shared with the engine and
every provider, for config fields ffprobe can answer: `width`/`height`/`fps`/
`durationSec`/`creationTime`, and the cheap `hasStream('gpmd')` check the CLI
uses to route to `provider-gopro` vs `provider-gpx` vs no telemetry. `Source`
also exposes a generic `bytes(streamTag)` for raw per-stream extraction
(cached on the instance), but **`provider-gopro` does not use it**: it bypasses
`Source` and hands the file path straight to `gpx-from-gopro`'s
`readGoproTelemetry`, which does its **own** independent mp4 probe (mp4box) and
its **own** cache (a `<file>.gpxcache.json` sidecar, see the lib's
`docs/export-contract.md` §E) — a second, unrelated pass over the same file.
So "does this video have GPS?" (routing) is a shared-probe lookup, but the GPS
*extraction* itself is not shared or cached through `Source` at all.

---

## 4. Segment timeline — multi-file (single file = N=1)

The engine owns a list of segments. Each segment descriptor:

```js
{ file: 'GH020001.MP4',  // full path (engine-owned list)
  offset: 120,           // playback position in the OUTPUT timeline, seconds
                         //   = cumulative duration of prior segments (gaps NOT counted)
  duration: 95,
  startUtc: <epoch ms>,  // wall-clock anchor for THIS segment (§5)
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

**Invocation.** The engine hands each provider the full `sources` list ✅, and a
provider applies each segment's `offset` when merging its samples onto the global
timeline ✅ (`provider-gopro` reads every file-bearing source and offset-merges).
Sidecar UTC alignment (external `.gpx`) is ✅ (`provider-gpx`, §3); `.fit` is 🔜.

---

## 5. Clock resolution (engine) — structural + per-segment GPS + continue-time + gap + regression-verify ✅

Each segment's `startUtc` is resolved by the engine from candidate anchors. Done:
the **structural** part (explicit `startUtc` else the segment's `creation_time`);
**per-segment GPS** — a provider reports `clocks: [{ sourceIndex, startUtc,
confidence:'gps' }]` and the engine upgrades each non-explicit segment over
`creation_time`; **continue-time** — a weak segment inherits the nearest reliable
neighbour's anchor via cumulative duration (marked `continued`); **back-derive** —
an *unverified*-GPS segment (delayed first fix) contiguous with a trusted
(explicit/verified-GPS) anchor inherits its clock, recovering the lock delay (with
a plausible-delay contiguity guard); **absurd-anchor demotion** — an *unverified*
GPS anchor skewed > 30 days from a trusted anchor's cumulative-duration
expectation (a no-lock track's stale/bogus GPSU arriving as a plausible-looking
clock) is demoted and refilled by continue-time, instead of poisoning the wall
clock / footage span / stamped `creation_time`; **gap detection** — two
*independent* reliable anchors disagreeing with cumulative duration flag a
`gap`; and the **regression-verified true start** (below). `frame.segment` now carries
`confidence` + `gap`.

### Precedence (per segment)
```
GPS (verified)  >  container creation_time  >  file mtime (untrusted)  >  none
```

- **GPS** — only the data provider can derive it (back-calc from the gpmd GPS
  samples). It is a *candidate*, reported to the engine as
  `clock: { startUtc, confidence:'gps', verified }`. "GPS" means **first good fix**
  (3D, low DOP, valid GPSU); robustness via **linear regression of UTC vs
  media-offset, slope ≈ 1**. Fails the quality gate → fall through.
  *Status ✅: `gpx-from-gopro` extracts each sample's media offset (`cts`) and
  regresses UTC vs `cts` (`resolveStartUtc`); when slope ≈ 1 it returns the
  extrapolated true start with `verified:true`, else falls back to first-fix.
  `provider-gopro` anchors each segment on that — so a verified segment's first fix
  lands `lockDelay` into playback (pre-display gray before lock, as intended), and
  the engine still gets a per-segment `clocks` candidate (with `verified`). An
  *unverified* segment (e.g. a short or lock-late chapter 1) contiguous with a
  verified later chapter is then **back-derived** to its true start (engine step 2).*
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

### Two-phase data load — clock-aligned providers see resolved anchors ✅

A data provider that *aligns against* the wall clock (a sidecar, §3) is marked
**`needsClock: true`** and loads in a **second round**: the engine loads the
clock-producing providers first, runs the clock resolution above, rebuilds the
per-segment timeline with the upgraded anchors, and only then loads the
`needsClock` providers. So a GoPro-video + GPX render aligns the sidecar to the
clip's GPS-verified true-UTC start instead of a wrong `creation_time` (GoPro
stamps the camera's *local* clock with a `Z`). Clock candidates returned by a
second-round provider are not re-adjudicated (a no-`cts` sidecar can't anchor
the video — below). The CLI backs a `--gpx` render with a **clock-only**
`provider-gopro` (`gopro({ clockOnly: true })` — clocks + timezone, no telemetry
channels) whenever the clip also carries embedded GPS.

### continue-time × gap (the v3→v4 case)
If `v4` has no GPS, the engine **continues** `v3`'s GPS anchor (`v3.startUtc +
v3.duration`) → `v3→v4` is seamless. Because `v4`'s anchor is *derived* (not an
independent reading), gap detection does **not** fire — which is the desired
behaviour.

### Wrong camera clock → manual `clockOffsetSec` (not auto best-clock-wins)
(When the clip itself carries GPS, this section is moot — the two-phase load
above anchors on the in-video GPS clock, no correction needed.)
When the video clock is wrong (a mis-set camera clock — the common real cause)
but a sidecar (Garmin GPX) has authoritative GPS UTC, you **cannot** recover the
correction automatically: unlike in-video GPS (whose samples carry a media
offset `cts` that ties them to the frames), a **sidecar has no intrinsic link to
the video frames** — its only bridge to the timeline is a shared, *trustworthy*
wall clock. If the camera clock is off by an unknown N seconds, both the
alignment *and* the displayed time inherit that same N-second error, and the GPX
can't tell you N (it doesn't know when you pressed record). Guessing
"GPX start = video start" is usually wrong (pre-roll), so we do **not** do it.

What *can* be fixed automatically is the **timezone** — a constant display offset
independent of the sync error (GPS lat/lon → IANA tz, already done below).

The sync/value error is corrected by the **human**, who knows their camera was
off: **`clockOffsetSec`** (Engine config) — a signed seconds nudge added to the
resolved wall-clock anchor (`trueStartUtc = resolvedStartUtc + clockOffsetSec`),
positive = camera slow / shift later, negative = camera fast / shift earlier. It
corrects **both** sidecar alignment (it flows into the segment timeline before
alignment) **and** the displayed `dateTime`, and combines with `startDateTime`
(nudge the explicit anchor too). A GPS-derived clock, if a provider supplies one,
supersedes it (and needs no correction). ✅ ·  *(no automatic sidecar
best-clock-wins — intentionally out of scope, see above)*

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
today it is one global value. ✅ engine resolution + GPS→tz derivation (provider —
`provider-gopro` surfaces `gpx-from-gopro`'s `timezoneOfPoints`; `provider-gpx`
derives its own from the sidecar's first placed point via the same lib's
`timezoneAt`, an offline `tz-lookup` lat/lon→IANA mapping) · 🔜 per-segment tz
(cross-timezone travel).

**Multi-provider tie-break: LAST non-null wins** (`DataSet.loadFrom`) — the
opposite of `clocks`/`meta`'s first-wins. Across the two-phase load above, this
means a `needsClock` sidecar's own tz (round 2, e.g. `provider-gpx` reading a
dedicated GPS unit) overrides a round-1 clock provider's (e.g. `provider-gopro`
backing a `--gpx` render's clock, whose position may never have gotten a real
lock at all — §5's regression-verified true start only needs `time`~`cts` to
line up, not a position fix), falling back to round 1's candidate if round 2
has none.

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

**Channel fill (`channelFill`) ✅** — sample-level splicing, complementing the
whole-channel merge above: a SECONDARY source (published under prefixed channel
names, e.g. `gopro({ channelPrefix: 'gopro:' })`) backfills the primary
channels' signal holes. Windows are found on the primary `gps` channel — an
inter-sample gap > `minGapSec` whose endpoints moved > `minMoveM` horizontally
(a paused-but-stationary recorder needs no fill), plus the tail when the
primary ends > `minGapSec` before the timeline does — then each `fills` pair's
secondary samples inside a window are inserted and the `drop` names removed.
The two receivers can disagree by metres, so each window edge gets a `blendSec`
(default 5 s) linear taper toward the primary's edge value — the splice lands
exactly on the primary endpoint instead of stepping sideways (short windows
split the taper evenly; the tail blends on its start side only). A fills entry
may instead be `{ from, edge: 'hold' }`: the edges stay EMPTY (the gauge
freezes across them) and the middle splices raw — used for `gradient`, a
derived ratio a positional taper would corrupt.
The CLI wires this automatically for a `--gpx` render on a clip with embedded
GPS (1 min / 100 m thresholds). Runs after both load rounds (§5 two-phase),
deterministically — `--jobs` chunks recompute identical fills.

The splice windows are also stashed on the `DataSet` (`_fillWindows`), gating
`DataSet#isBackfilled(t)` alongside a provider-reported `meta.hero10` flag —
dashboard-spec §4's colour cue, so a viewer can tell a spliced-in reading apart
from the sidecar's own. Both survive the `prepareData()` → `_scene()`
JSON-bundle round-trip every render (not just `--jobs`) goes through, the same
`Infinity`-safe null-then-revive trick `maxGap` already used.

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
| `clockOffsetSec` — fix a wrong camera clock | **human** supplies, **engine** applies |
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
`provider-svg`; `provider-gpx` (sidecar `.gpx` → gps/speed/altitude + derived
gradient channels, UTC-aligned to the segment timeline, adapts `gpx-stabilizer`'s
`readGpx`, §3; gradient via a shared `src/gradient.js` helper, also used by gopro);
`provider-gopro` (gps/speed/altitude + derived gradient channels,
GPS→tz timezone, per-segment GPS `clocks` candidates — adapts `gpx-from-gopro`,
multi-source offset-merge); **clock resolution** — per-segment pick (explicit >
GPS > creation_time) + continue-time fill + back-derive (unverified-GPS chapter from
a verified neighbour) + gap detection, `frame.segment.{confidence,gap}`;
**regression-verified true start** (`gpx-from-gopro` regresses UTC vs media-offset
`cts`, slope ≈ 1 gate; provider anchors on the verified start, restoring pre-display gray);
**manual `clockOffsetSec`** — signed seconds nudge fixing a wrong camera clock,
correcting both sidecar alignment and displayed `dateTime` (§5); **two-phase data
load** — `needsClock` (sidecar) providers load after clock resolution, so a
GoPro + `--gpx` render aligns to the GPS true-UTC anchors (CLI adds a clock-only
`provider-gopro` when the clip has embedded GPS) (§5).

🔜 Planned: sidecar `.fit` UTC alignment (binary FIT decoder — the `.gpx`
alignment path is done, §3); provider-private `setup` → shared resources; perf
path (`toBuffer('raw')`/bgra, DoubleBuffer, GPU profiles). (Dashboard
presentation layer — display smoothing + derived-`speed` — is implemented; see
[`dashboard-spec.md`](dashboard-spec.md).)
