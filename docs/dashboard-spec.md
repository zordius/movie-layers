# Dashboard / Presentation — gauge values & smoothing — Spec

How the dashboard turns telemetry channels into gauge numbers, and how those
numbers are kept stable. Companion to
[`data-timeline-spec.md`](data-timeline-spec.md) (the data + timeline layer).

**Status: §2 display smoothing and §3 derived-`speed` fallback are implemented ✅;
the lib-side source reconstruction (§0/§4) remains proposed (🔜).**

---

## 0. Principle — gauges are one signal's derivative tower

Almost every numeric gauge is a **projection or derivative of a single 3D position
track** (planar lat/lon + elevation), not an independent sensor:

| gauge | is | source axis |
|---|---|---|
| latlon / track / gps | position | **planar (x/y)** |
| altitude | `ele` | **elevation** |
| speed (derived) | \|Δposition\| / Δt | **planar** (1st derivative) |
| gradient | Δele / horizontal-dist | **elevation ÷ planar** (a ratio) |

Consequence: **stabilize the one position signal and the whole derivative tower
inherits it** — clean the two source axes (planar + elevation) and nearly every
gauge gets steadier "for free". This is exactly gpx-stabilizer's `measure.js`
*derivative tower* (`velocity → acceleration`); it's the **high-leverage** place to
clean data — one fix, many gauges.

**But differentiation amplifies residual noise.** Each derivative order re-injects
high-frequency noise:

- **position-level** gauges (altitude / latlon / track) → stabilize **fully**;
- **rate-level** gauges (speed = 1st-order, gradient ≈ 2nd-order ratio) → improve a
  lot but **still need their own smoothing** — a clean `ele` still yields a jumpy
  slope because slope is a ratio of small differences.

(gpx-stabilizer deliberately omits `jerk` for the same reason — *"3rd-order
differences of 1 Hz GPS are dominated by noise"* — and gradient needs its ~20 m
baseline.) So **source-stabilization and a thin presentation smoothing are
complementary, ordered layers — not duplicates.**

**Exception — device speed.** GoPro's device `speed` is GPS-**Doppler**, not
position differencing, so it is *not* a function of the stabilized track (and
`stabilize` currently drops it). It is the one gauge source-stabilization never
touches.

---

## 1. Three "smoothings" — disambiguation

Three distinct things all get called "smoothing"; the spec keeps them separate:

| layer | where | mutates the data number? | fixes |
|---|---|---|---|
| interpolation / gap-hold | data accessor (`frame.data`, data-spec §2) | **no** (computed per query) | values *between* samples |
| **display smoothing** (this doc, §2) | the **gauge / widget** | **no** | **visual jitter** (rate of change) |
| source reconstruction | the **lib** (gpx-stabilizer SPEC) | **yes** (cleans `ele` / position) | **GPS noise at the source** |

Display smoothing makes a gauge **move** smoothly; it does **not** shrink a value's
real range — a gradient swinging −39…+26 % still reaches the extremes, only the
**source** layer narrows that. Don't conflate them.

---

## 2. Display smoothing (dashboard feature) ✅

A **presentation-only** smoothing applied by the numeric **scalar** gauges:

- **What** — the displayed value approaches its data target with a **smoothed rate
  of change** (no frame-to-frame snapping): speed smooths the speed's rate,
  gradient the gradient's rate, etc. ✅ for `speed` / `altitude` / `gradient`.
- **Scalar only** — positional gauges (`latlon` / `track`, which read `gps`) are
  **excluded**: smoothing a coordinate lags the map dot (trades jitter for lag).
- **Display-only** — lives in the widget (a `Layer` holds per-frame state via
  `src/smooth.js`'s `Smoother`); it **never alters `frame.data` return values** —
  the underlying channel stays raw.
- **Config** — Engine option **`gaugeSmoothing` (default `true`)**, injected into
  every widget's config; a per-layout `smooth: false` (and `smoothTime`) overrides.
  The CLI exposes `--no-smooth`.
- **Interaction with `valid` / freeze** — while a channel reads `valid:false` (gap,
  pre-fix, held across `maxGap`), the gauge **holds (freezes)** and smoothing
  **pauses** (velocity zeroed); it resumes across `valid` transitions without a
  snap — a frozen value never drifts.
- **Filter** — a **critically-damped follow** (the "SmoothDamp" kernel): the value's
  *velocity* is smoothed, so it **never overshoots**; one time constant
  `smoothTime` (default **0.35 s**). First real sample snaps (no sweep from 0).

---

## 3. Derived `speed` fallback (provider) ✅

When a telemetry source lacks device `speed`, the provider derives **horizontal
ground speed** from the position track:

- **Trigger = wholly absent only.** Derived **only when the `speed` channel is
  otherwise entirely empty** (e.g. after `stabilize`, which drops device speed; or a
  `.gpx` with no `<speed>`). If a source *has* device speed, it's kept — the more
  accurate Doppler reading. (`provider-gopro` computes the derived series per
  segment, holds it aside, and promotes it only if no segment reported speed.)
- **Intermittent → freeze, not per-point derive.** If `speed` is present at some
  points and missing at others, nothing special happens: the missing points aren't
  added, and data-spec §2 gap-hold / interpolation handles them (the "freeze"
  route). Derivation is all-or-nothing per source.
- **How** — `speedSamples()` (shared helper in `src/gradient.js`, beside
  `gradientSamples`): distance over a ~`windowSec`-second **trailing window**
  (default **1 s**, not adjacent samples) → km/h. The window tames the per-sample
  noise that differentiating position amplifies; §2 display smoothing then polishes
  the gauge.
- Both `provider-gopro` and `provider-gpx` use the same helper.

---

## 4. Status

✅ **Implemented:**

- display smoothing (§2) — critically-damped, presentation-only, scalar gauges,
  Engine `gaugeSmoothing` toggle **default-on** (`--no-smooth` / per-widget
  override); `src/smooth.js`.
- derived-`speed` fallback (§3) — `speedSamples` shared helper (1 s window),
  triggered only when the `speed` channel is wholly absent; gopro + gpx.

Source-axis reconstruction (the upstream this layer sits on, §0) is the
**gpx-stabilizer** side — its SPEC's *elevation-reconstruction (track smoothing)*
contract. This presentation layer is the thin residual-polish on top; the lib's
position/elevation stabilization is the high-leverage fix that steadies most gauges
at the source.
