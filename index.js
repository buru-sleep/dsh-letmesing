/**
 * dsh-letmesing — Host half.
 *
 * Serves the selected music folder over the local HTTP carrier so the browser
 * half can play it. The folder itself is chosen by the user through the host's
 * native directory picker and persisted outside the browser (port-randomized
 * origins make browser storage unreliable across restarts).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIR = path.join(PACKAGE_ROOT, 'assets', 'music')
const PREFIX = '/dsh-letmesing'
const CONFIG_DIR = path.join(os.homedir(), '.dsh', 'letmesing')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.opus': 'audio/opus',
}

const AUDIO_RE = /\.(mp3|m4a|aac|ogg|oga|wav|flac|webm|opus)$/i

// The config file is read on every music request, so keep the resolved folder
// in memory and refresh it only when this process writes a new value.
let configCache = null

function readConfig() {
  if (configCache) return configCache
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    const dir = typeof parsed?.dir === 'string' ? parsed.dir.trim() : ''
    configCache = { dir: dir || DEFAULT_DIR }
  } catch {
    configCache = { dir: DEFAULT_DIR }
  }
  return configCache
}

function writeConfig(next) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
    configCache = { dir: next.dir }
    return true
  } catch (error) {
    throw new Error(`cannot write ${CONFIG_FILE}: ${error?.message ?? error}`)
  }
}

function existingDir(candidate) {
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : ''
  } catch {
    return ''
  }
}

/** Configured folder when it still exists, otherwise the bundled default. */
function musicDir() {
  const configured = existingDir(readConfig().dir)
  if (configured) return configured
  return existingDir(DEFAULT_DIR) ? DEFAULT_DIR : ''
}

// A folder of thousands of tracks should not turn into a huge listing: cap the
// result so /api/list stays cheap no matter what folder the user picks.
const MAX_TRACKS = 2000

function listMusic(dir) {
  if (!dir) return []
  try {
    const names = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !AUDIO_RE.test(entry.name)) continue
      names.push(entry.name)
      if (names.length >= MAX_TRACKS) break
    }
    return names.sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= 1_000_000) chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendAudio(req, res, file) {
  const ext = path.extname(file).toLowerCase()
  const type = AUDIO_MIME[ext] ?? 'application/octet-stream'
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }

  const range = req.headers.range
  const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  if (match) {
    const start = match[1] ? Number(match[1]) : 0
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    })
    fs.createReadStream(file, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  })
  fs.createReadStream(file).pipe(res)
}

function snapshot() {
  const dir = musicDir()
  return {
    dir: dir || '',
    defaultDir: DEFAULT_DIR,
    files: listMusic(dir),
  }
}

export const inject = ['webServer']

export function apply(ctx) {
  const disposers = []

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/api/config`,
      handler(req, res) {
        if (req.method === 'POST') {
          readBody(req).then((body) => {
            const candidate = typeof body.dir === 'string' ? body.dir.trim() : ''
            const resolved = existingDir(candidate)
            if (!resolved) {
              sendJson(res, 400, { error: `not a folder: ${candidate || '(empty)'}` })
              return
            }
            try {
              writeConfig({ dir: resolved })
              sendJson(res, 200, snapshot())
            } catch (error) {
              sendJson(res, 500, { error: String(error?.message ?? error) })
            }
          })
          return
        }
        sendJson(res, 200, snapshot())
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/api/pick`,
      handler(req, res) {
        const picker = ctx.get('directoryPickerController')
        if (!picker || typeof picker.pick !== 'function') {
          sendJson(res, 501, {
            error: 'directory picker unavailable; set the folder path manually',
          })
          return
        }
        Promise.resolve()
          .then(() => picker.pick(new AbortController().signal))
          .then((picked) => {
            if (!picked) {
              sendJson(res, 200, { cancelled: true, ...snapshot() })
              return
            }
            const resolved = existingDir(picked)
            if (!resolved) {
              sendJson(res, 400, { error: `not a folder: ${picked}` })
              return
            }
            writeConfig({ dir: resolved })
            sendJson(res, 200, { picked: resolved, ...snapshot() })
          })
          .catch((error) => {
            sendJson(res, 500, { error: String(error?.message ?? error) })
          })
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/api/list`,
      handler(req, res) {
        sendJson(res, 200, snapshot())
      },
    }),
  )

  // Diagnostic ring buffer: the client reports stream chunk types it observes,
  // so playback problems can be traced without opening devtools.
  const chunkLog = []
  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/api/log`,
      handler(req, res) {
        if (req.method === 'POST') {
          readBody(req).then((body) => {
            if (body && typeof body.type === 'string') {
              chunkLog.push({
                type: body.type,
                sample: typeof body.sample === 'string' ? body.sample.slice(0, 240) : '',
                at: Date.now(),
              })
              if (chunkLog.length > 40) chunkLog.splice(0, chunkLog.length - 40)
            }
            sendJson(res, 200, { ok: true })
          })
          return
        }
        sendJson(res, 200, { entries: chunkLog })
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: `${PREFIX}/music`,
      handler(req, res) {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const raw = decodeURIComponent(
            url.pathname.slice(`${PREFIX}/music`.length).replace(/^\/+/, ''),
          )
          const safe = path.basename(raw)
          const dir = musicDir()
          if (!safe || !dir) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('not found')
            return
          }
          sendAudio(req, res, path.join(dir, safe))
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(String(error?.message ?? error))
        }
      },
    }),
  )

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {}
    }
  })
}

export { PREFIX }
