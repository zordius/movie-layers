/**
 * Data layer — time-varying channels, engine-brokered, consumed by layers.
 *
 * A data provider parses a source once (`load`) and returns named channels of
 * samples. The engine merges all providers into a DataSet and exposes, per
 * frame, a time-bound view: `frame.data.get/series/stats/unit/has`.
 *
 * "Data = time-varying"; constants are config, heavy assets are resources.
 * This module knows nothing about GoPro/GPX — a provider (e.g. provider-gopro)
 * adapts a source into this shape.
 */
/**
 * Sugar for a data-only provider: `{ name, load }` → `{ name, data: load }`.
 * Equivalent to `defineProvider({ name, data: load })`.
 */
export function defineDataProvider(spec) {
  if (!spec || typeof spec.name !== 'string' || typeof spec.load !== 'function') {
    throw new Error('DataProvider must be { name: string, load: async ({sources,config}) => { channels } }')
  }
  return { name: spec.name, data: spec.load }
}

/** Linear interpolation: number | number[] | {numeric fields}; else nearest. */
function lerp(a, b, f) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * f
  if (Array.isArray(a) && Array.isArray(b)) return a.map((v, i) => lerp(v, b[i], f))
  if (a && b && typeof a === 'object') {
    const out = {}
    for (const k of Object.keys(a)) {
      out[k] = typeof a[k] === 'number' && typeof b[k] === 'number' ? lerp(a[k], b[k], f) : a[k]
    }
    return out
  }
  return f < 0.5 ? a : b // non-numeric: hold nearest
}

class Channel {
  constructor(name, unit, samples, maxGap = Infinity) {
    this.name = name
    this.unit = unit ?? null
    this.maxGap = maxGap // seconds; a larger inter-sample gap is treated as "no signal"
    // samples: [{ t (seconds), value }], sorted by t
    this.samples = [...samples].sort((p, q) => p.t - q.t)
    this._stats = null
  }

  /**
   * { value, valid } at time t. `value` is always usable when samples exist —
   * clamped before-first / after-last, and held (not interpolated) across a gap
   * > maxGap — so a widget can pre-display the upcoming value. `valid` is false
   * before the first sample (e.g. before GPS fix), after the last, and across a
   * too-large gap, so the widget can render it dimmed/provisional.
   */
  sample(t) {
    const s = this.samples
    if (s.length === 0) return { value: undefined, valid: false }
    const first = s[0]
    const last = s[s.length - 1]
    if (t <= first.t) return { value: first.value, valid: t === first.t }
    if (t >= last.t) return { value: last.value, valid: t === last.t }

    let lo = 0
    let hi = s.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (s[mid].t <= t) lo = mid
      else hi = mid
    }
    const a = s[lo]
    const b = s[hi]
    const span = b.t - a.t
    if (span > this.maxGap) return { value: a.value, valid: false } // hold across a gap
    return { value: lerp(a.value, b.value, span === 0 ? 0 : (t - a.t) / span), valid: true }
  }

  /** Value at time t (clamped/held); see sample() for validity. */
  at(t) {
    return this.sample(t).value
  }

  series() {
    return this.samples
  }

  stats() {
    if (this._stats !== null) return this._stats
    let min = Infinity
    let max = -Infinity
    let sum = 0
    let n = 0
    for (const { value } of this.samples) {
      if (typeof value === 'number') {
        if (value < min) min = value
        if (value > max) max = value
        sum += value
        n++
      }
    }
    this._stats = n ? { min, max, avg: sum / n, count: n } : undefined
    return this._stats
  }
}

export class DataSet {
  constructor() {
    this.channels = new Map()
  }

  addChannel(name, unit, samples, maxGap) {
    // overwrite allowed — conflict precedence is decided in load()
    this.channels.set(name, new Channel(name, unit, samples, maxGap))
  }

  has(name) {
    return this.channels.has(name)
  }

  list() {
    return [...this.channels.keys()]
  }

  /**
   * Load + merge channels from all data providers. On a channel-name conflict:
   *  - `merge[name]` set → only the provider whose `name` matches wins;
   *  - otherwise → last writer wins.
   *
   * (Mirrors gopro-dashboard-overlay's --gpx-merge OVERWRITE.)
   */
  static async load(dataProviders, { sources = [], config = {}, merge = {} } = {}) {
    const set = new DataSet()
    const owner = new Map() // channel name -> provider name currently owning it
    for (const provider of dataProviders) {
      const result = await provider.data({ sources, config })
      const channels = result?.channels ?? {}
      for (const [name, ch] of Object.entries(channels)) {
        const preferred = merge[name]
        const take =
          !owner.has(name) || (preferred !== undefined ? provider.name === preferred : true)
        if (take) {
          set.addChannel(name, ch.unit, ch.samples ?? [], ch.maxGap)
          owner.set(name, provider.name)
        }
      }
    }
    return set
  }

  /**
   * A reusable, time-bound accessor. Set `_t` per frame (synchronous draw);
   * `series`/`stats` ignore time, `get` reads at `_t`.
   */
  view() {
    const set = this
    return {
      _t: 0,
      get(name) {
        const c = set.channels.get(name)
        return c ? c.at(this._t) : undefined
      },
      sample(name) {
        const c = set.channels.get(name)
        return c ? c.sample(this._t) : { value: undefined, valid: false }
      },
      valid(name) {
        const c = set.channels.get(name)
        return c ? c.sample(this._t).valid : false
      },
      series(name) {
        const c = set.channels.get(name)
        return c ? c.series() : undefined
      },
      stats(name) {
        const c = set.channels.get(name)
        return c ? c.stats() : undefined
      },
      unit(name) {
        const c = set.channels.get(name)
        return c ? c.unit : undefined
      },
      has(name) {
        return set.has(name)
      },
    }
  }
}
