import { spawn } from 'node:child_process'

function runJson(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => {
      out += d
    })
    proc.stderr.on('data', (d) => {
      err += d
    })
    proc.on('error', (e) =>
      reject(new Error(`Unable to run '${bin}' — is it installed? (${e.message})`)),
    )
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${bin} exited ${code}: ${err.trim()}`))
      try {
        resolve(JSON.parse(out))
      } catch (e) {
        reject(new Error(`${bin} JSON parse failed: ${e.message}`))
      }
    })
  })
}

/** Raw ffprobe JSON: { streams, format }. The shared-probe primitive. */
export async function probeContainer(path, { ffprobe = 'ffprobe' } = {}) {
  return runJson(ffprobe, [
    '-hide_banner',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    path,
  ])
}

/** Derive the constant config fields (CONFIG, not data) from raw ffprobe JSON. */
export function deriveInfo(json) {
  const streams = json.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video')
  if (!v) throw new Error('No video stream found')

  const [num, den] = (v.avg_frame_rate ?? '0/1').split('/').map(Number)
  const fps = den ? num / den : null

  const durRaw = v.duration ?? json.format?.duration
  const durationSec = durRaw != null && !Number.isNaN(parseFloat(durRaw)) ? parseFloat(durRaw) : null

  const ct = json.format?.tags?.creation_time ?? null
  const ctMs = ct ? Date.parse(ct) : NaN
  const creationTime = Number.isNaN(ctMs) ? null : ctMs

  return { width: v.width, height: v.height, fps, durationSec, creationTime }
}

/**
 * Probe a video's container metadata (CONFIG, not data — all constant). One
 * ffprobe pass; the engine uses it to derive canvas size / duration / wall-clock
 * anchor. creationTime in epoch ms (or null) — can be wrong (camera clock); a
 * GPS-derived anchor from a data provider overrides it.
 */
export async function probeVideo(path, opts = {}) {
  return deriveInfo(await probeContainer(path, opts))
}
