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
export function defineDataProvider(spec) {
  if (!spec || typeof spec.name !== 'string' || typeof spec.load !== 'function') {
    throw new Error('DataProvider must be { name: string, load: async (config) => { channels, timeRange? } }')
  }
  return spec
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
  constructor(name, unit, samples) {
    this.name = name
    this.unit = unit ?? null
    // samples: [{ t (seconds), value }], sorted by t
    this.samples = [...samples].sort((p, q) => p.t - q.t)
    this._stats = null
  }

  /** Value at time t (seconds), linearly interpolated; clamped at the ends. */
  at(t) {
    const s = this.samples
    if (s.length === 0) return null
    if (t <= s[0].t) return s[0].value
    if (t >= s[s.length - 1].t) return s[s.length - 1].value

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
    return lerp(a.value, b.value, span === 0 ? 0 : (t - a.t) / span)
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

  addChannel(name, unit, samples) {
    if (this.channels.has(name)) throw new Error(`Duplicate data channel "${name}"`)
    this.channels.set(name, new Channel(name, unit, samples))
  }

  has(name) {
    return this.channels.has(name)
  }

  list() {
    return [...this.channels.keys()]
  }

  static async load(dataProviders, { sources = [], config = {} } = {}) {
    const set = new DataSet()
    for (const provider of dataProviders) {
      const result = await provider.load({ sources, config })
      const channels = result?.channels ?? {}
      for (const [name, ch] of Object.entries(channels)) {
        set.addChannel(name, ch.unit, ch.samples ?? [])
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
