import { spawn } from 'node:child_process'

import { probeContainer, deriveInfo } from './probe.js'

/** Dump one stream's raw bytes (-codec copy), like the Python load_data. */
function extractStream(file, index, { ffmpeg = 'ffmpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpeg,
      ['-hide_banner', '-y', '-i', file, '-map', `0:${index}`, '-codec', 'copy', '-f', 'rawvideo', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const chunks = []
    let err = ''
    proc.stdout.on('data', (d) => chunks.push(d))
    proc.stderr.on('data', (d) => {
      err += d
    })
    proc.on('error', (e) => reject(new Error(`Unable to run ffmpeg (${e.message})`)))
    proc.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`ffmpeg exited ${code}: ${err.trim()}`)),
    )
  })
}

/**
 * A shared handle to one source video segment. Probes ONCE (cached) and caches
 * per-stream byte extraction, so "does this video have GPS?" is a lookup on the
 * shared probe — core and every data provider read the same Source instead of
 * re-opening the file.
 *
 * Carries the segment's place in the timeline:
 *  - offset   playback position in the OUTPUT timeline (seconds)
 *  - startUtc wall-clock anchor for this segment (epoch ms | null)
 *
 * Stream lookup matches `codec_type` ('video'|'audio'|'data') OR
 * `codec_tag_string` ('gpmd' for GoPro telemetry).
 */
export class Source {
  constructor(file, { offset = 0, startUtc = null, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) {
    this.file = file
    this.offset = offset
    this.startUtc = startUtc
    this._ffmpeg = ffmpeg
    this._ffprobe = ffprobe
    this._probe = null
    this._info = null
    this._bytes = new Map()
  }

  async probe() {
    return (this._probe ??= await probeContainer(this.file, { ffprobe: this._ffprobe }))
  }

  /** { width, height, fps, durationSec, creationTime } */
  async info() {
    return (this._info ??= deriveInfo(await this.probe()))
  }

  async findStream(tag) {
    const { streams = [] } = await this.probe()
    return streams.find((s) => s.codec_type === tag || s.codec_tag_string === tag) ?? null
  }

  async hasStream(tag) {
    return (await this.findStream(tag)) != null
  }

  /** Raw bytes of the first stream matching `tag` (cached); null if absent. */
  async bytes(tag) {
    if (this._bytes.has(tag)) return this._bytes.get(tag)
    const s = await this.findStream(tag)
    const buf = s ? await extractStream(this.file, s.index, { ffmpeg: this._ffmpeg }) : null
    this._bytes.set(tag, buf)
    return buf
  }
}
