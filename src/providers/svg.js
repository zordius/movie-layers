import { readFileSync } from 'node:fs'

import canvasPkg from '@napi-rs/canvas'

import { Layer, defineProvider } from '../layer.js'

const { Image } = canvasPkg

/** Rasterize SVG (string | Buffer) to a drawable Image — synchronous in @napi-rs/canvas. */
function rasterize(svg) {
  const img = new Image()
  img.src = Buffer.isBuffer(svg) ? svg : Buffer.from(svg)
  return img
}

const isInlineSvg = (s) => typeof s === 'string' && s.trimStart().startsWith('<')

/**
 * Draw an SVG as a layer.
 *
 *   { type: 'svg', src: '<svg…>' | './badge.svg' | Buffer, x, y, width, height, opacity }
 *   { type: 'svg', render: (frame) => '<svg…>' , x, y, … }   // animation: re-rasterized per frame
 *
 * `src` is decoded once and cached; `render` is decoded each frame.
 */
class SvgLayer extends Layer {
  constructor(config = {}) {
    super()
    this.x = config.x ?? 0
    this.y = config.y ?? 0
    this.width = config.width ?? null
    this.height = config.height ?? null
    this.opacity = config.opacity ?? 1
    this.render = typeof config.render === 'function' ? config.render : null

    this._static = null
    if (!this.render) {
      const { src } = config
      if (src == null) {
        throw new Error('svg layer needs `src` (inline SVG / file path / Buffer) or `render(frame)`')
      }
      const buf = Buffer.isBuffer(src) ? src : isInlineSvg(src) ? Buffer.from(src) : readFileSync(src)
      this._static = rasterize(buf)
    }
  }

  draw(ctx, frame) {
    const img = this.render ? rasterize(this.render(frame)) : this._static
    if (!img) return
    const w = this.width ?? img.width
    const h = this.height ?? img.height
    const prev = ctx.globalAlpha
    if (this.opacity !== 1) ctx.globalAlpha = this.opacity
    ctx.drawImage(img, this.x, this.y, w, h)
    ctx.globalAlpha = prev
  }
}

export default defineProvider({
  name: 'svg',
  layers: {
    svg: (config) => new SvgLayer(config),
  },
})
