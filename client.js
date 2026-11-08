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
    }
    const FADE_MS = 420
    const FADE_IN_MS = 700
    const REASONING_IDLE_MS = 1200

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
    }

    const audio = new Audio()
    audio.preload = 'auto'
    audio.loop = true
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

    function currentTrack() {
      if (!files.length) return ''
      if (config.file && files.indexOf(config.file) >= 0) return config.file
      return files[0]
    }

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
      if (!unlocked) {
        wantPlay = true
        return
      }
      const track = currentTrack()
      if (!track) return
      wantPlay = true
      const src = PREFIX + '/music/' + encodeURIComponent(track)
      const changed = audio.getAttribute('src') !== src
      if (changed) audio.setAttribute('src', src)
      if (audio.paused) {
        cancelFade()
        audio.volume = 0
        const attempt = audio.play()
        if (attempt && typeof attempt.then === 'function') {
          attempt.then(() => fadeIn(), () => {})
        } else {
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
      if (fadeTimer || audio.paused) return
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
        stopNow()
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
        startPlaying()
        return
      }
      if (config.mode === 'turn') {
        if (running) {
          cancelStop()
          startPlaying()
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

    function markReasoning() {
      lastReasoningAt = Date.now()
      if (!config.enabled || config.mode !== 'reasoning') return
      cancelStop()
      startPlaying()
    }

    // Diagnostic probe: off by default. Run `localStorage.setItem('letmesing.debug','1')`
    // in the console and reload when a chunk-level bug needs investigation.
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
      // Only the tail matters: `replace` can carry the whole history, and
      // re-scanning it every frame would cost more as the session grows.
      const start = Math.max(0, change.entries.length - 5)
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
        if (type === 'reasoning-delta' || type === 'reasoning') {
          markReasoning()
          return
        }
        if (type === 'text-delta' || type === 'text') {
          if (config.mode === 'reasoning' && !audio.paused) fadeOut()
          return
        }
        if (type === 'finish') {
          if (config.mode === 'reasoning') fadeOut()
          return
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

    function LetMeSingSettings() {
      const [enabled, setEnabled] = React.useState(config.enabled)
      const [mode, setMode] = React.useState(config.mode)
      const [volume, setVolume] = React.useState(config.volume)
      const [dir, setDir] = React.useState(folder)
      const [list, setList] = React.useState(files)
      const [track, setTrack] = React.useState(config.file)
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
        settlePlayback()
      }

      function changeMode(next) {
        setMode(next)
        config.mode = next
        lsWrite(LS.mode, next)
        settlePlayback()
      }

      function changeVolume(next) {
        setVolume(next)
        config.volume = next
        audio.volume = next
        lsWrite(LS.volume, next)
      }

      function changeTrack(next) {
        setTrack(next)
        switchTrack(next)
      }

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
          { title: '曲目', desc: list.length ? `当前文件夹有 ${list.length} 首` : '这个文件夹里没有音频文件' },
          list.length === 0
            ? React.createElement(
                'div',
                { style: { fontSize: 13, opacity: 0.7 } },
                '支持 mp3 / m4a / aac / ogg / wav / flac / webm / opus。',
              )
            : React.createElement(
                'select',
                {
                  value: track || list[0],
                  onChange: (event) => changeTrack(event.target.value),
                  style: { width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 13 },
                },
                list.map((name) =>
                  React.createElement('option', { key: name, value: name }, name),
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
      acquireLeadership()

      // Safety net: if a reasoning burst stops without a text chunk, fade out.
      const watchdog = setInterval(() => {
        if (!config.enabled || config.mode !== 'reasoning') return
        if (audio.paused) return
        if (!lastReasoningAt) return
        if (Date.now() - lastReasoningAt > REASONING_IDLE_MS) fadeOut()
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
