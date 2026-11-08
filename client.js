// Re-running the boot script in the same page context would register this
// module id a second time and fail the entire web boot, so latch it.
// Surface boot failures where they can actually be read: the crash dialog only
// prints "import failed", so every uncaught error and rejection goes to the
// host log instead. This runs before anything else can throw.
try {
  const report = (type, message) => {
    try {
      fetch('/dsh-letmesing/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, sample: String(message).slice(0, 240), at: Date.now() }),
      }).catch(() => {})
    } catch {}
  }
  window.addEventListener('error', (event) => {
    const error = event && (event.error || event.message)
    report('win-error', (error && (error.stack || error.message || error)) || 'unknown')
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason
    report('win-rejection', (reason && (reason.stack || reason.message)) || String(reason || 'unknown'))
  })
} catch {}

// Always (re-)register. A boot that re-runs in the same page context still
// holds this module id, so the loader rejects the duplicate — harmless, and far
// better than skipping the registration: a skipped entry stays inactive and
// aborts the whole web boot.
try {
  window.__ModuleLoader__.load({
  id: 'dsh-letmesing',
  factory(require) {
    'use strict'

    const React = require('react')

    const PREFIX = '/dsh-letmesing'
    const LS = {
      enabled: 'letmesing.enabled',
      mode: 'letmesing.mode',
      volume: 'letmesing.volume',
      file: 'letmesing.file',
      playMode: 'letmesing.playMode',
    }
    const FADE_MS = 420
    const FADE_IN_MS = 700
    const REASONING_IDLE_MS = 1200
    // How long answer text keeps playback silent after the last text chunk.
    const TEXT_PHASE_MS = 1500

    function lsString(key, fallback) {
      try {
        const value = localStorage.getItem(key)
        return value === null ? fallback : value
      } catch {
        return fallback
      }
    }

    function lsNumber(key, fallback) {
      const parsed = parseFloat(lsString(key, String(fallback)))
      return isFinite(parsed) ? parsed : fallback
    }

    function lsBool(key, fallback) {
      return lsString(key, fallback ? '1' : '0') === '1'
    }

    function lsWrite(key, value) {
      try {
        localStorage.setItem(key, String(value))
      } catch {}
    }

    const config = {
      enabled: lsBool(LS.enabled, true),
      // 'turn'      = whenever the whole turn is running (default)
      // 'reasoning' = only while the model is actually thinking
      // 'always'    = always
      mode: lsString(LS.mode, 'turn'),
      volume: Math.min(1, Math.max(0, lsNumber(LS.volume, 0.45))),
      file: lsString(LS.file, ''),
      // 'one'      = repeat the current track (default)
      // 'shuffle'  = pick a random other track when one ends
      // 'sequence' = play the folder in order, wrapping at the end
      playMode: lsString(LS.playMode, 'one'),
      // User-chosen playback order; empty means "the order the host returned".
      order: [],
    }

    const audio = new Audio()
    audio.preload = 'auto'
    audio.loop = config.playMode === 'one'
    audio.volume = config.volume
    audio.addEventListener('error', () => {
      const code = audio.error ? audio.error.code : 0
      reportChunk('audio-error', 'code=' + code)
    })

    let unlocked = false
    let wantPlay = false
    let stopTimer = 0
    let fadeTimer = 0
    let lastReasoningAt = 0
    let lastRunning = false
    // Set once answer text starts and cleared when the model moves on to a tool
    // call, so the watchdog cannot restart music halfway through a written
    // answer while the turn is still running.
    let turnHadText = false
    // Set when the model asks the user something; later activity clears it.
    let pausedForUser = false
    // Last moment answer text arrived. A timestamp rather than a flag: when the
    // matching block-start is missed the phase expires on its own instead of
    // keeping playback silent for the rest of the turn.
    let lastTextAt = 0
    function inTextPhase() {
      return lastTextAt > 0 && Date.now() - lastTextAt < TEXT_PHASE_MS
    }
    let files = []
    let folder = ''
    let filesPromise = null
    let sessionsApi = null
    let watched = null

    let isLeader = false
    let leadershipStarted = false

    function holdLockOnce() {
      return navigator.locks
        .request('letmesing-playback', { ifAvailable: true }, async (lock) => {
          if (!lock) return false
          isLeader = true
          reportChunk('diag-leader', '')
          try {
            settlePlayback()
          } catch {}
          await new Promise(() => {})
          return true
        })
        .catch(() => false)
    }

    function acquireLeadership() {
      if (leadershipStarted) return
      leadershipStarted = true
      if (typeof navigator === 'undefined' || !navigator.locks) {
        isLeader = true
        return
      }
      holdLockOnce().then((got) => {
        if (got) return
        reportChunk('diag-not-leader', '')
        try {
          stopNow()
        } catch {}
        setInterval(() => {
          if (isLeader) return
          holdLockOnce().catch(() => {})
        }, 3000)
      })
    }

    function unlock() {
      unlocked = true
      if (wantPlay) startPlaying()
    }

    try {
      window.addEventListener('pointerdown', unlock, { once: true })
      window.addEventListener('keydown', unlock, { once: true })
    } catch {}

    function adoptSnapshot(body) {
      if (!body || typeof body !== 'object') return
      if (typeof body.dir === 'string') folder = body.dir
      if (Array.isArray(body.files)) {
        files = body.files
        if (files.length && files.indexOf(config.file) < 0) {
          config.file = files[0]
          lsWrite(LS.file, config.file)
        }
      }
      if (body.prefs && typeof body.prefs === 'object') adoptPrefs(body.prefs)
    }

    // The host file is the durable copy: the desktop port changes on every
    // start, and origin-scoped storage is lost with it. Applied once, at the
    // first load, so a later snapshot cannot overwrite what the user just did.
    let prefsLoaded = false
    function adoptPrefs(prefs) {
      if (prefsLoaded) return
      prefsLoaded = true
      if (typeof prefs.enabled === 'boolean') config.enabled = prefs.enabled
      if (MODES.some((item) => item.key === prefs.mode)) config.mode = prefs.mode
      if (PLAY_MODES.some((item) => item.key === prefs.playMode)) config.playMode = prefs.playMode
      if (typeof prefs.volume === 'number' && isFinite(prefs.volume)) {
        config.volume = Math.min(1, Math.max(0, prefs.volume))
      }
      if (typeof prefs.file === 'string') config.file = prefs.file
      if (Array.isArray(prefs.order)) config.order = prefs.order.slice()
      try {
        audio.volume = config.volume
        audio.loop = config.playMode === 'one'
      } catch {}
    }

    let prefsTimer = 0
    function savePrefs() {
      if (prefsTimer) clearTimeout(prefsTimer)
      prefsTimer = setTimeout(() => {
        prefsTimer = 0
        try {
          fetch(PREFIX + '/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefs: config }),
          }).catch(() => {})
        } catch {}
      }, 600)
    }

    function loadFiles(force) {
      if (filesPromise && !force) return filesPromise
      filesPromise = fetch(PREFIX + '/api/list')
        .then((response) => response.json())
        .then((body) => {
          adoptSnapshot(body)
          return files
        })
        .catch(() => {
          files = []
          return files
        })
      return filesPromise
    }

    // Playback order = the user's explicit order first, then anything the host
    // returned that the order does not mention (new files land at the end).
    function orderedFiles() {
      if (!Array.isArray(config.order) || !config.order.length) return files
      const out = []
      const seen = {}
      for (const name of config.order) {
        if (files.indexOf(name) >= 0 && !seen[name]) {
          out.push(name)
          seen[name] = true
        }
      }
      for (const name of files) {
        if (!seen[name]) out.push(name)
      }
      return out
    }

    // Whether playback should be audible right now. `ended` used to rely on the
    // wantPlay flag alone, which fade-out clears — so a track that finished
    // while the answer was being written never came back.
    function shouldPlayNow() {
      if (!config.enabled || !isLeader) return false
      if (config.mode === 'always') return true
      if (config.mode === 'turn') {
        return Boolean(lastRunning) && !inTextPhase() && !pausedForUser
      }
      return lastReasoningAt > 0 && Date.now() - lastReasoningAt < REASONING_IDLE_MS
    }

    function currentTrack() {
      const list = orderedFiles()
      if (!list.length) return ''
      if (config.file && list.indexOf(config.file) >= 0) return config.file
      return list[0]
    }

    function nextTrackName() {
      const list = orderedFiles()
      if (list.length <= 1) return currentTrack()
      const current = currentTrack()
      if (config.playMode === 'shuffle') {
        let pick = current
        // Avoid replaying the same song; the guard keeps tiny folders cheap.
        for (let i = 0; i < 24 && pick === current; i += 1) {
          pick = list[Math.floor(Math.random() * list.length)]
        }
        return pick
      }
      const at = list.indexOf(current)
      return list[(at < 0 ? 0 : at + 1) % list.length]
    }

    // `loop` covers the single-track case, so advancing only matters for
    // shuffle and sequence. Playback continues only if it was wanted already:
    // a track that ends during a fade-out should stay silent.
    audio.addEventListener('ended', () => {
      if (config.playMode === 'one') return
      const next = nextTrackName()
      if (!next) return
      // Decide from the mode, not from wantPlay: a fade-out clears wantPlay, so
      // a track that finished during the answer would otherwise stay silent.
      const resume = shouldPlayNow()
      config.file = next
      lsWrite(LS.file, next)
      savePrefs()
      audio.setAttribute('src', PREFIX + '/music/' + encodeURIComponent(next))
      try {
        audio.load()
      } catch {}
      if (!resume) return
      audio.volume = 0
      const attempt = audio.play()
      if (attempt && typeof attempt.then === 'function') {
        attempt.then(() => fadeIn(), () => {})
      } else {
        fadeIn()
      }
    })

    function cancelFade() {
      if (fadeTimer) {
        clearInterval(fadeTimer)
        fadeTimer = 0
      }
    }

    function fadeIn() {
      cancelFade()
      const target = config.volume
      const from = audio.paused ? 0 : Math.min(audio.volume, target)
      if (from >= target - 0.001) {
        audio.volume = target
        return
      }
      audio.volume = from
      const startedAt = Date.now()
      fadeTimer = setInterval(() => {
        const k = Math.min(1, (Date.now() - startedAt) / FADE_IN_MS)
        audio.volume = from + (target - from) * k
        if (k >= 1) {
          clearInterval(fadeTimer)
          fadeTimer = 0
          audio.volume = target
        }
      }, 40)
    }

    function startPlaying() {
      if (!config.enabled) return
      if (!isLeader) return
      const track = currentTrack()
      if (!track) return
      wantPlay = true
      const src = PREFIX + '/music/' + encodeURIComponent(track)
      const changed = audio.getAttribute('src') !== src
      if (changed) audio.setAttribute('src', src)
      if (audio.paused) {
        cancelFade()
        audio.volume = 0
        // Try even without a recorded gesture: the page may already have one
        // from earlier, while this module instance never saw it — a hot reload
        // drops module state, not the browser's per-page gesture. Only a real
        // refusal waits for a click.
        const attempt = audio.play()
        if (attempt && typeof attempt.then === 'function') {
          attempt.then(() => {
            unlocked = true
            fadeIn()
          }, () => {
            wantPlay = true
          })
        } else {
          unlocked = true
          fadeIn()
        }
        return
      }
      if (changed) {
        audio.volume = 0
        fadeIn()
        return
      }
      if (audio.volume < config.volume - 0.001) fadeIn()
    }

    function stopNow() {
      wantPlay = false
      cancelFade()
      try {
        audio.pause()
      } catch {}
    }

    function fadeOut() {
      if (audio.paused) return
      // A fade-in may still be running — the answer can start inside its 700 ms.
      // Cancel it first, otherwise the early return below leaves the track
      // climbing back to full volume and it never fades.
      cancelFade()
      reportAlways('fade-out', 'paused=' + audio.paused + ' vol=' + audio.volume.toFixed(2))
      wantPlay = false
      const from = audio.volume
      const startedAt = Date.now()
      fadeTimer = setInterval(() => {
        const k = Math.min(1, (Date.now() - startedAt) / FADE_MS)
        audio.volume = from * (1 - k)
        if (k >= 1) {
          clearInterval(fadeTimer)
          fadeTimer = 0
          try {
            audio.pause()
          } catch {}
          audio.volume = config.volume
        }
      }, 40)
    }

    function scheduleStop() {
      if (stopTimer) clearTimeout(stopTimer)
      stopTimer = setTimeout(() => {
        stopTimer = 0
        // Fade instead of a hard cut: a turn that ends mid-loop should not click.
        cancelFade()
        fadeOut()
      }, REASONING_IDLE_MS)
    }

    function cancelStop() {
      if (stopTimer) {
        clearTimeout(stopTimer)
        stopTimer = 0
      }
    }

    let lastRunningReport = ''
    function reportRunning(running) {
      // The host log only keeps `type`, so pack the state into the type string.
      const key = (running ? 'run1' : 'run0') + ' ' + config.mode + ' p' + (audio.paused ? 1 : 0)
      if (key === lastRunningReport) return
      lastRunningReport = key
      reportAlways(key, '')
    }

    function applyRunning(running) {
      reportRunning(running)
      lastRunning = !!running
      if (!config.enabled) {
        cancelStop()
        stopNow()
        return
      }
      if (config.mode === 'always') {
        cancelStop()
        if (!pausedForUser) startPlaying()
        return
      }
      if (config.mode === 'turn') {
        if (running) {
          resumePlayback()
        } else {
          scheduleStop()
        }
        return
      }
      // reasoning mode: the stream drives playback, running only stops it.
      if (!running) {
        cancelStop()
        fadeOut()
      }
    }

    function settlePlayback() {
      if (!config.enabled) {
        cancelStop()
        stopNow()
        return
      }
      if (config.mode === 'always') {
        cancelStop()
        startPlaying()
        return
      }
      if (config.mode === 'turn') {
        if (lastRunning) {
          cancelStop()
          startPlaying()
        } else {
          cancelStop()
          fadeOut()
        }
        return
      }
      if (!lastRunning) {
        cancelStop()
        fadeOut()
      }
    }

    function resumePlayback() {
      if (!config.enabled) return
      if (pausedForUser || inTextPhase()) return
      cancelStop()
      startPlaying()
    }

    function stopForText() {
      // "always" means always; in the other modes the answer itself is silence.
      if (config.mode === 'always') return
      lastTextAt = Date.now()
      cancelStop()
      reportAlways(
        'text-stop',
        'mode=' + config.mode + ' paused=' + audio.paused + ' vol=' + audio.volume.toFixed(2),
      )
      fadeOut()
    }

    // Diagnostic probe: off by default. Run `localStorage.setItem('letmesing.debug','1')`
    // in the console and reload when a chunk-level bug needs investigation.
    // TEMPORARY: on by default while chasing "answer text does not fade out".
    // Flip back to `=== '1'` before the release.
    const DEBUG = (() => {
      try {
        return localStorage.getItem('letmesing.debug') !== '0'
      } catch {
        return true
      }
    })()

    function reportAlways(type, sample) {
      if (!DEBUG) return
      try {
        fetch(PREFIX + '/api/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, sample: sample || '', at: Date.now() }),
        }).catch(() => {})
      } catch {}
    }

    let lastReportedType = ''
    function reportChunk(type, sample) {
      if (!DEBUG) return
      if (!type || type === lastReportedType) return
      lastReportedType = type
      try {
        fetch(PREFIX + '/api/log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, sample: sample || '', at: Date.now() }),
        }).catch(() => {})
      } catch {}
    }

    function inspectChange(change) {
      if (!change || !Array.isArray(change.entries)) return
      // A single change can carry several chunks: a `replace` ships the whole
      // window, and one turn boundary often delivers text-delta and the next
      // block-start together. Inspect every entry in the tail in order —
      // stopping at the first match would drop that block-start and leave
      // playback silent for the rest of the turn.
      const start = Math.max(0, change.entries.length - 12)
      for (let i = start; i < change.entries.length; i += 1) {
        const entry = change.entries[i]
        if (!entry || entry.type !== 'transient') continue
        const chunk = entry.event && entry.event.data && entry.event.data.chunk
        if (!chunk) continue
        const type = chunk.type
        let sample = ''
        try {
          sample = JSON.stringify(chunk).slice(0, 220)
        } catch {}
        reportChunk(type, sample)
        if (type === 'block-start') {
          pausedForUser = false
          if (chunk.blockType === 'text') {
            stopForText()
          } else {
            resumePlayback()
          }
          continue
        }
        if (type === 'reasoning-delta' || type === 'reasoning') {
          pausedForUser = false
          lastReasoningAt = Date.now()
          resumePlayback()
          continue
        }
        if (type === 'text-delta' || type === 'text') {
          // The model is writing the answer: it is no longer "thinking".
          turnHadText = true
          stopForText()
          continue
        }
        if (type === 'tool-call-delta') {
          if (chunk.name === 'ask_user_question') {
            pausedForUser = true
            cancelStop()
            fadeOut()
            continue
          }
          pausedForUser = false
          resumePlayback()
          continue
        }
        if (type === 'block-end') {
          const block = chunk.block
          if (block && block.type === 'tool-call' && block.name === 'ask_user_question') {
            // Waiting on the user: go quiet until the next block starts.
            pausedForUser = true
            cancelStop()
            fadeOut()
          }
          continue
        }
        if (type === 'finish') {
          turnHadText = false
          pausedForUser = false
          if (config.mode === 'always') continue
          // A tool run usually means the user has to decide something — an
          // approval prompt — before the turn continues. That is their turn, so
          // go quiet here; the next reasoning burst brings the music back.
          scheduleStop()
        }
      }
    }

    function watchSession(sessionId) {
      if (!sessionsApi) {
        reportChunk('diag-no-sessions-api', '')
        return
      }
      if (!sessionId) {
        reportChunk('diag-no-session-id', '')
        return
      }
      if (watched && watched.sessionId === sessionId) return
      if (watched) {
        try {
          watched.unsubscribe()
        } catch {}
        if (watched.sessionUnsub) {
          try {
            watched.sessionUnsub()
          } catch {}
        }
        watched = null
      }
      let binding
      try {
        binding = sessionsApi.binding(sessionId)
      } catch {
        binding = undefined
      }
      if (!binding || !binding.eventSource) {
        reportChunk('diag-no-binding', String(sessionId).slice(0, 12))
        return
      }
      const source = binding.eventSource
      let entryCount = -1
      try {
        entryCount = source.getSnapshot().entries.length
      } catch {}
      reportChunk('diag-subscribed', 'entries=' + entryCount)
      const unsubscribe = source.subscribe(() => {
        let window_ = null
        try {
          window_ = source.getSnapshot()
        } catch {}
        if (window_) inspectChange(window_.change)
      })
      // Slot props can lag behind the live snapshot, so read `running` from the
      // session face itself; this is what actually stops playback when a turn ends.
      let sessionUnsub = null
      const face = binding.session
      if (face && typeof face.getSnapshot === 'function' && typeof face.subscribe === 'function') {
        let snap = null
        try {
          snap = face.getSnapshot()
        } catch {}
        if (snap) applyRunning(snap.running)
        sessionUnsub = face.subscribe(() => {
          let next = null
          try {
            next = face.getSnapshot()
          } catch {}
          if (next) applyRunning(next.running)
        })
      }
      watched = { sessionId, unsubscribe, sessionUnsub }
    }

    function switchTrack(next) {
      config.file = next
      lsWrite(LS.file, next)
      if (!audio.paused || config.mode === 'always') {
        try {
          audio.pause()
        } catch {}
        startPlaying()
      }
    }

    function MusicController(props) {
      const session = props.session
      const running = Boolean(session && session.running)
      const sessionId = session && session.sessionId

      React.useEffect(() => {
        let alive = true
        loadFiles().then(() => {
          if (!alive) return
          watchSession(sessionId)
          applyRunning(running)
        })
        return () => {
          alive = false
          if (watched) {
            try {
              watched.unsubscribe()
            } catch {}
            if (watched.sessionUnsub) {
              try {
                watched.sessionUnsub()
              } catch {}
            }
            watched = null
          }
          // Nobody drives the audio once this mount goes away; leaving it
          // running is how "the model stopped thinking but music kept playing" happens.
          stopNow()
        }
      }, [])

      React.useEffect(() => {
        watchSession(sessionId)
      }, [sessionId, running])

      React.useEffect(() => {
        applyRunning(running)
      }, [running])

      return null
    }

    function SettingRow(props) {
      return React.createElement(
        'div',
        {
          style: {
            padding: '14px 0',
            borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.22))',
          },
        },
        React.createElement(
          'div',
          { style: { fontWeight: 600, fontSize: 14, marginBottom: 4 } },
          props.title,
        ),
        props.desc
          ? React.createElement(
              'div',
              { style: { fontSize: 12, opacity: 0.6, marginBottom: 8, wordBreak: 'break-all' } },
              props.desc,
            )
          : null,
        props.children,
      )
    }

    function buttonStyle(primary) {
      return {
        padding: '6px 14px',
        borderRadius: 8,
        cursor: 'pointer',
        fontSize: 13,
        border: primary ? '1px solid #2b6cf6' : '1px solid rgba(128,128,128,0.35)',
        background: primary ? 'rgba(43,108,246,0.16)' : 'transparent',
        color: 'inherit',
      }
    }

    const MODES = [
      { key: 'turn', label: '整轮运行', hint: '从发出消息到这一轮结束都播放（默认）' },
      { key: 'reasoning', label: '推理时', hint: '模型真正在思考时才播放，开始回答就淡出' },
      { key: 'always', label: '常驻', hint: '打开页面就一直播放' },
    ]

    const PLAY_MODES = [
      { key: 'one', label: '单曲循环', hint: '一直重复当前这一首（默认）' },
      { key: 'shuffle', label: '随机播放', hint: '一首放完，随机换一首' },
      { key: 'sequence', label: '顺序播放', hint: '一首放完，播列表里的下一首，到末尾回到开头' },
    ]

    function LetMeSingSettings() {
      const [enabled, setEnabled] = React.useState(config.enabled)
      const [mode, setMode] = React.useState(config.mode)
      const [playMode, setPlayMode] = React.useState(config.playMode)
      const [volume, setVolume] = React.useState(config.volume)
      const [dir, setDir] = React.useState(folder)
      const [list, setList] = React.useState(files)
      const [track, setTrack] = React.useState(config.file)
      const [order, setOrder] = React.useState(() => orderedFiles())
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [manual, setManual] = React.useState('')
      const [leader, setLeader] = React.useState(isLeader)

      React.useEffect(() => {
        const timer = setInterval(() => setLeader(isLeader), 800)
        return () => clearInterval(timer)
      }, [])

      function absorb(body) {
        if (!body || typeof body !== 'object') return
        const prevDir = folder
        adoptSnapshot(body)
        if (prevDir && body.dir && body.dir !== prevDir) stopNow()
        if (typeof body.dir === 'string') setDir(body.dir)
        setList(files)
        setTrack(config.file)
        setOrder(orderedFiles())
        if (body.error) setError(body.error)
        else if (!body.cancelled) setError('')
      }

      React.useEffect(() => {
        let alive = true
        loadFiles(true).then((next) => {
          if (!alive) return
          setDir(folder)
          setList(next)
          setTrack(config.file)
          setOrder(orderedFiles())
        })
        return () => {
          alive = false
        }
      }, [])

      function pickFolder() {
        setBusy(true)
        setError('')
        fetch(PREFIX + '/api/pick', { method: 'POST' })
          .then((response) => response.json())
          .then((body) => absorb(body))
          .catch((err) => setError(String(err && err.message ? err.message : err)))
          .finally(() => setBusy(false))
      }

      function applyManual() {
        const target = manual.trim()
        if (!target) return
        setBusy(true)
        setError('')
        fetch(PREFIX + '/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: target }),
        })
          .then((response) => response.json())
          .then((body) => {
            absorb(body)
            if (!body.error) setManual('')
          })
          .catch((err) => setError(String(err && err.message ? err.message : err)))
          .finally(() => setBusy(false))
      }

      function toggleEnabled() {
        const next = !enabled
        setEnabled(next)
        config.enabled = next
        lsWrite(LS.enabled, next ? '1' : '0')
        savePrefs()
        settlePlayback()
      }

      function changeMode(next) {
        setMode(next)
        config.mode = next
        lsWrite(LS.mode, next)
        savePrefs()
        settlePlayback()
      }

      function changePlayMode(next) {
        setPlayMode(next)
        config.playMode = next
        lsWrite(LS.playMode, next)
        audio.loop = next === 'one'
        savePrefs()
      }

      function changeVolume(next) {
        setVolume(next)
        config.volume = next
        audio.volume = next
        lsWrite(LS.volume, next)
        savePrefs()
      }

      function changeTrack(next) {
        setTrack(next)
        config.file = next
        lsWrite(LS.file, next)
        savePrefs()
        switchTrack(next)
      }

      function moveTrack(name, delta) {
        const list = orderedFiles().slice()
        const at = list.indexOf(name)
        const to = at + delta
        if (at < 0 || to < 0 || to >= list.length) return
        const swapped = list[to]
        list[to] = list[at]
        list[at] = swapped
        config.order = list
        setOrder(list)
        setTrack(currentTrack())
        savePrefs()
      }

      const rows = order.length ? order : orderedFiles()

      return React.createElement(
        'div',
        null,
        React.createElement(
          SettingRow,
          { title: 'LetMeSing', desc: '模型思考时播放你选定的背景音乐' },
          React.createElement(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 } },
            React.createElement('input', {
              type: 'checkbox',
              checked: enabled,
              onChange: toggleEnabled,
              style: { width: 16, height: 16 },
            }),
            React.createElement('span', null, enabled ? '已启用' : '已停用'),
          ),
        ),
        React.createElement(
          SettingRow,
          { title: '播放时机', desc: MODES.find((item) => item.key === mode)?.hint || '' },
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            MODES.map((item) =>
              React.createElement(
                'button',
                {
                  key: item.key,
                  onClick: () => changeMode(item.key),
                  style: buttonStyle(mode === item.key),
                },
                item.label,
              ),
            ),
          ),
        ),
        React.createElement(
          SettingRow,
          { title: '播放方式', desc: PLAY_MODES.find((item) => item.key === playMode)?.hint || '' },
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            PLAY_MODES.map((item) =>
              React.createElement(
                'button',
                {
                  key: item.key,
                  onClick: () => changePlayMode(item.key),
                  style: buttonStyle(playMode === item.key),
                },
                item.label,
              ),
            ),
          ),
        ),
        React.createElement(
          SettingRow,
          { title: '音量', desc: '拖动调节，立即生效' },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 12 } },
            React.createElement('input', {
              type: 'range',
              min: 0,
              max: 1,
              step: 0.01,
              value: volume,
              onChange: (event) => changeVolume(parseFloat(event.target.value)),
              style: { flex: 1 },
            }),
            React.createElement(
              'span',
              { style: { fontSize: 13, minWidth: 42, textAlign: 'right' } },
              Math.round(volume * 100) + '%',
            ),
          ),
        ),
        React.createElement(
          SettingRow,
          {
            title: '音乐文件夹',
            desc: dir || '还没有选择文件夹（当前使用插件自带的 assets/music）',
          },
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8, marginBottom: 8 } },
            React.createElement(
              'button',
              { onClick: pickFolder, disabled: busy, style: buttonStyle(true) },
              busy ? '处理中…' : '选择文件夹…',
            ),
            React.createElement(
              'button',
              {
                onClick: () => {
                  setBusy(true)
                  loadFiles(true)
                    .then((next) => {
                      setDir(folder)
                      setList(next)
                      setTrack(config.file)
                      setBusy(false)
                    })
                    .catch(() => setBusy(false))
                },
                disabled: busy,
                style: buttonStyle(false),
              },
              '刷新列表',
            ),
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8 } },
            React.createElement('input', {
              type: 'text',
              value: manual,
              placeholder: '也可以直接粘路径，例如 D:\\Music',
              onChange: (event) => setManual(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') applyManual()
              },
              style: {
                flex: 1,
                padding: '6px 8px',
                borderRadius: 6,
                fontSize: 13,
                border: '1px solid rgba(128,128,128,0.35)',
                background: 'transparent',
                color: 'inherit',
              },
            }),
            React.createElement(
              'button',
              { onClick: applyManual, disabled: busy || !manual.trim(), style: buttonStyle(false) },
              '使用',
            ),
          ),
          error
            ? React.createElement(
                'div',
                { style: { fontSize: 12, color: '#e5484d', marginTop: 8 } },
                error,
              )
            : null,
        ),
        React.createElement(
          SettingRow,
          {
            title: '曲目',
            desc: list.length
              ? `共 ${list.length} 首，点一首切过去；↑ ↓ 调整顺序，「顺序播放」按这个次序走`
              : '这个文件夹里没有音频文件',
          },
          list.length === 0
            ? React.createElement(
                'div',
                { style: { fontSize: 13, opacity: 0.7 } },
                '支持 mp3 / m4a / aac / ogg / wav / flac / webm / opus。',
              )
            : React.createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                rows.map((name, index) =>
                  React.createElement(
                    'div',
                    { key: name, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                    React.createElement(
                      'span',
                      { style: { width: 18, fontSize: 12, opacity: 0.55, textAlign: 'right' } },
                      String(index + 1),
                    ),
                    React.createElement(
                      'button',
                      {
                        onClick: () => changeTrack(name),
                        title: name,
                        style: {
                          flex: 1,
                          minWidth: 0,
                          textAlign: 'left',
                          padding: '5px 9px',
                          borderRadius: 6,
                          fontSize: 13,
                          cursor: 'pointer',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          border:
                            name === track
                              ? '1px solid #2b6cf6'
                              : '1px solid rgba(128,128,128,0.3)',
                          background:
                            name === track ? 'rgba(43,108,246,0.14)' : 'transparent',
                          color: 'inherit',
                        },
                      },
                      (name === track ? '▶ ' : '') + name,
                    ),
                    React.createElement(
                      'button',
                      {
                        onClick: () => moveTrack(name, -1),
                        disabled: index === 0,
                        title: '上移',
                        style: buttonStyle(false),
                      },
                      '↑',
                    ),
                    React.createElement(
                      'button',
                      {
                        onClick: () => moveTrack(name, 1),
                        disabled: index === rows.length - 1,
                        title: '下移',
                        style: buttonStyle(false),
                      },
                      '↓',
                    ),
                  ),
                ),
              ),
        ),
        React.createElement(
          SettingRow,
          {
            title: '播放窗口',
            desc: leader ? '本窗口负责播放' : '另一个窗口正在播放，本窗口保持静默',
          },
          React.createElement(
            'span',
            { style: { fontSize: 12, opacity: 0.7 } },
            leader ? '● 正在播放' : '○ 静默',
          ),
        ),
      )
    }

    const inject = ['slots', 'sessions']

    function apply(ctx) {
      try {
        sessionsApi = ctx.sessions || ctx.get('sessions') || null
      } catch {
        sessionsApi = null
      }
      reportChunk('diag-init', sessionsApi ? 'sessions=ok' : 'sessions=null')
      // Temporary probe: the config decides whether answer text can ever fade
      // playback out, so record it alongside the chunk trace.
      reportAlways(
        'diag-config',
        'mode=' + config.mode + ' playMode=' + config.playMode + ' enabled=' + (config.enabled ? 1 : 0),
      )
      acquireLeadership()

      // Safety net. Reasoning mode: a burst that ends without a text chunk
      // fades out. Turn mode: if the turn is still running and nothing is
      // deliberately holding us quiet, resuming here recovers a missed chunk
      // transition instead of leaving the track silent for the rest of the turn.
      const watchdog = setInterval(() => {
        if (!config.enabled) return
        if (config.mode === 'reasoning') {
          if (audio.paused || !lastReasoningAt) return
          if (Date.now() - lastReasoningAt > REASONING_IDLE_MS) fadeOut()
          return
        }
        if (
          config.mode === 'turn' &&
          lastRunning &&
          !inTextPhase() &&
          !pausedForUser &&
          !turnHadText &&
          audio.paused
        ) {
          resumePlayback()
        }
      }, 350)
      ctx.effect(() => () => clearInterval(watchdog))

      ctx.effect(() =>
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'letmesing',
              order: 60,
            },
            MusicController,
          ),
        ),
      )

      ctx.effect(() =>
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'letmesing',
              order: 26,
              label: () => 'LetMeSing',
            },
            LetMeSingSettings,
          ),
        ),
      )

      loadFiles().then(() => {
        if (config.enabled && config.mode === 'always') startPlaying()
      })
    }

    return {
      inject,
      apply,
      MusicController,
      LetMeSingSettings,
    }
  },
  })
} catch (error) {
  // Already registered by an earlier boot in this page: keep that one.
}
