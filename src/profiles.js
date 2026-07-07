/**
 * ffmpeg encoding profiles — the CLI's `--profile <name>` (mirrors
 * gopro-dashboard-overlay's profile system). A profile is a set of ffmpeg arg
 * arrays that replace the default encode:
 *
 *   { input?: [...], output: [...], filter?: "[0:v][1:v]overlay" }
 *
 * `output` is mandatory; `input` (decode options, e.g. `-hwaccel`) applies only
 * when overlaying onto a base video; `filter` overrides the overlay filtergraph
 * (needed for some GPU paths). Built-ins below are overridden/extended by a user
 * file at `~/.config/movie-layers/ffmpeg-profiles.json` (same shape).
 *
 * Profiles only affect renders that ENCODE (overlay or pure-generated) — a
 * no-overlay stitch is a lossless stream copy and ignores them.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const BUILTIN_PROFILES = {
  // the engine default, spelled out (libx264 / veryfast / yuv420p, x264 default CRF 23)
  default: { output: ['-vcodec', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'] },
  // higher quality, slower + smaller — visually near-transparent vs the source
  hq: { output: ['-vcodec', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'] },
  // NVIDIA GPU encode — needs an ffmpeg built with nvenc + a CUDA GPU (untested here)
  nvgpu: {
    input: ['-hwaccel', 'nvdec'],
    output: ['-vcodec', 'h264_nvenc', '-rc:v', 'cbr', '-b:v', '50M', '-bf:v', '3', '-profile:v', 'high', '-spatial-aq', 'true'],
  },
  // VP9 webm (slower, smaller) — use a `.webm` output filename
  vp9: { output: ['-vcodec', 'vp9', '-pix_fmt', 'yuv420p'] },
}

/**
 * Hardware H.264 encoders, in preference order, for the auto-upgrade path. The first
 * one this ffmpeg build actually has wins. Kept minimal (just `-vcodec` + a bitrate, no
 * `-hwaccel`/preset) so it's robust across ffmpeg versions. HW encoders are bitrate- not
 * CRF-driven; `-b:v 8.5M` is tuned to land near the software x264 default (~8.3 Mbps), so
 * the auto-upgrade buys speed at roughly the same file size.
 */
const HW_BITRATE = '8.5M'
export const HW_ENCODERS = [
  { codec: 'h264_videotoolbox', label: 'VideoToolbox (Apple)', output: ['-vcodec', 'h264_videotoolbox', '-b:v', HW_BITRATE, '-pix_fmt', 'yuv420p'] },
  { codec: 'h264_nvenc', label: 'NVENC (NVIDIA)', output: ['-vcodec', 'h264_nvenc', '-b:v', HW_BITRATE, '-pix_fmt', 'yuv420p'] },
  { codec: 'h264_qsv', label: 'QuickSync (Intel)', output: ['-vcodec', 'h264_qsv', '-b:v', HW_BITRATE, '-pix_fmt', 'yuv420p'] },
  { codec: 'h264_amf', label: 'AMF (AMD)', output: ['-vcodec', 'h264_amf', '-b:v', HW_BITRATE, '-pix_fmt', 'yuv420p'] },
]

let _encoders = null
/** Set of encoder names this ffmpeg build advertises (`ffmpeg -encoders`), cached. */
export function listEncoders(ffmpeg = 'ffmpeg') {
  if (_encoders) return _encoders
  let out = ''
  try {
    out = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    out = '' // ffmpeg missing / errored → no encoders detected, caller falls back to software
  }
  const set = new Set()
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*[VAS][\w.]*\s+(\S+)/) // " V....D h264_videotoolbox  ..." → name
    if (m) set.add(m[1])
  }
  _encoders = set
  return set
}

/**
 * Best available hardware H.264 encoder, or null when none is present (→ software). This
 * is the "detection-based auto-upgrade": picked automatically unless the user opts out
 * (`--no-hw`) or names an explicit `--profile`. Returns `{ codec, label, output }`.
 */
export function detectHwEncoder(ffmpeg = 'ffmpeg') {
  const have = listEncoders(ffmpeg)
  return HW_ENCODERS.find((e) => have.has(e.codec)) ?? null
}

/**
 * Hardware DECODE acceleration (`-hwaccel <name>` before the base `-i`), in preference
 * order — independent of the output encoder/profile: it only speeds up reading the base
 * video, not how the result gets encoded. `cuda`/`qsv` pair with their matching NVENC/QSV
 * encoders; `videotoolbox` is macOS's one hwaccel regardless of CPU vendor (Intel or
 * Apple Silicon — confirmed identical on both via `ffmpeg -hwaccels`).
 */
export const HW_DECODERS = [
  { hwaccel: 'videotoolbox', label: 'VideoToolbox (Apple)' },
  { hwaccel: 'cuda', label: 'CUDA (NVIDIA)' },
  { hwaccel: 'qsv', label: 'QuickSync (Intel)' },
]

let _hwaccels = null
/** Set of hwaccel names this ffmpeg build advertises (`ffmpeg -hwaccels`), cached. */
export function listHwaccels(ffmpeg = 'ffmpeg') {
  if (_hwaccels) return _hwaccels
  let out = ''
  try {
    out = execFileSync(ffmpeg, ['-hide_banner', '-hwaccels'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    out = '' // ffmpeg missing / errored → no hwaccels detected, caller decodes in software
  }
  const set = new Set(
    out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l !== 'Hardware acceleration methods:'),
  )
  _hwaccels = set
  return set
}

/** Best available hwaccel decode method, or null when none is present (→ software decode). */
export function detectHwDecode(ffmpeg = 'ffmpeg') {
  const have = listHwaccels(ffmpeg)
  return HW_DECODERS.find((d) => have.has(d.hwaccel)) ?? null
}

/** Default user-profile file: `$XDG_CONFIG_HOME|~/.config/movie-layers/ffmpeg-profiles.json`. */
export function defaultProfileFile() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'movie-layers', 'ffmpeg-profiles.json')
}

/**
 * Resolve a profile name to `{ input, output, filter }`. A user file (if present)
 * is merged over the built-ins by name. Throws — with the available names — on an
 * unknown name, an unreadable/!JSON file, or a profile missing its `output` array.
 */
export function resolveProfile(name, { file = defaultProfileFile() } = {}) {
  let user = {}
  if (existsSync(file)) {
    try {
      user = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      throw new Error(`cannot read ffmpeg profiles "${file}": ${e.message}`)
    }
  }
  const all = { ...BUILTIN_PROFILES, ...user }
  const p = all[name]
  if (!p) {
    throw new Error(`unknown --profile "${name}" (available: ${Object.keys(all).sort().join(', ')})`)
  }
  if (!Array.isArray(p.output)) {
    throw new Error(`profile "${name}" must have an \`output\` array of ffmpeg args`)
  }
  return { input: Array.isArray(p.input) ? p.input : [], output: p.output, filter: typeof p.filter === 'string' ? p.filter : null }
}
