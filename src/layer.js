/**
 * A Layer produces pixels at a given time. A base video, a speed gauge, a map,
 * or a full-frame SVG animation are all just Layers — composited bottom→top
 * into a single RGBA frame.
 *
 * @typedef {Object} Frame
 * @property {number} index        global frame index
 * @property {number} frameCount   total frames
 * @property {boolean} isFirst
 * @property {boolean} isLast
 * @property {number} timeSec      playback seconds (continuous across segments)
 * @property {number} dt           seconds since previous frame (1/fps)
 * @property {number} progress     0..1 through the movie
 * @property {number} durationSec  total length
 * @property {number} fps
 * @property {{index:number,localIndex:number,localTimeSec:number,startUtc:number|null}} segment
 * @property {Date|null} dateTime  segment.startUtc + localTime (may jump on a gap; null if no anchor)
 * @property {string|null} timezone
 * @property {{get,sample,valid,series,stats,unit,has}} data  time-bound data accessor (interpolated at timeSec)
 * @property {number} scale   logical→physical scale applied to the layer pass
 * @property {number} width   logical canvas width (physical / scale); scale by height → baseline × aspect
 * @property {number} height  logical canvas height (physical / scale) = the baseline
 */
export class Layer {
  /**
   * @param {import('@napi-rs/canvas').SKRSContext2D} ctx 2D context to draw into
   * @param {Frame} frame current frame info
   */
  // eslint-disable-next-line no-unused-vars
  draw(ctx, frame) {
    throw new Error(`${this.constructor.name}.draw(ctx, frame) not implemented`)
  }
}

/**
 * A provider module exports a Provider: `{ name, data?, layers? }` — at least
 * one facet.
 *
 *  - `data`   — async ({ sources, config }) => ({ channels, ... }); a
 *               time-varying data source (see data.js).
 *  - `layers` — map of `type` → factory `(config, ctx) => Layer`, or
 *               `{ needs: [channel], create }` to declare the channels a layer
 *               reads (validated up-front against the loaded DataSet).
 *
 * One package can ship both (e.g. provider-gopro: telemetry channels + widgets).
 * The engine takes a single `providers: [...]` array and routes by facet.
 *
 *   export default defineProvider({
 *     name: 'gopro',
 *     data:   async ({ sources }) => ({ channels: await parse(sources) }),
 *     layers: { 'speed': { needs: ['speed'], create: (c) => new SpeedGauge(c) } },
 *   })
 */
export function defineProvider(spec) {
  if (!spec || typeof spec.name !== 'string') {
    throw new Error('Provider must have a string `name`')
  }
  const hasData = spec.data !== undefined
  const hasLayers = spec.layers !== undefined
  if (!hasData && !hasLayers) {
    throw new Error(`Provider "${spec.name}" must have a \`data\` and/or \`layers\` facet`)
  }
  if (hasData && typeof spec.data !== 'function') {
    throw new Error(`Provider "${spec.name}" \`data\` must be an async function`)
  }
  if (hasLayers && (typeof spec.layers !== 'object' || spec.layers === null)) {
    throw new Error(`Provider "${spec.name}" \`layers\` must be an object`)
  }
  return spec
}

/** Resolves a layout's layer types against the installed providers. */
export class Registry {
  constructor(providers = []) {
    this.layers = new Map() // type -> { needs: string[], create: fn }
    for (const p of providers) this.add(p)
  }

  add(provider) {
    if (!provider.layers) return this // data-only provider — nothing to register here
    for (const [type, reg] of Object.entries(provider.layers)) {
      if (this.layers.has(type)) {
        throw new Error(`Duplicate layer type "${type}" (provider "${provider.name}")`)
      }
      const norm =
        typeof reg === 'function'
          ? { needs: [], create: reg }
          : { needs: reg.needs ?? [], create: reg.create }
      if (typeof norm.create !== 'function') {
        throw new Error(`Layer "${type}" registration needs a create() function`)
      }
      this.layers.set(type, norm)
    }
    return this
  }

  get(type) {
    const reg = this.layers.get(type)
    if (!reg) {
      throw new Error(`No layer registered for type "${type}". Did you load a provider for it?`)
    }
    return reg
  }

  create(type, config, ctx) {
    return this.get(type).create(config, ctx)
  }
}
