// Snout in Claude Code (mods). Two parts, one module:
// - the status line above the prompt: context used, tokens Snout kept out of this session, and what
//   memory holds for the repo. It reads Snout's local records under .snout/ and sends nothing.
// - Snout the anteater: switches to the Snout Pink theme once, animates above the prompt until the
//   first message of each session, opens with /snout, and flicks a tongue after the spinner word.
//   Both parts of the character have a switch in /config (snout.character, snout.pinkTheme), which
//   /snout on|off and /snout pink on|off set.
// Claude Code versions without mods ignore this file; the command hooks in hooks.json still run.

import type { ConfigRow, ConfigValue, EngineInterface, Register, ResolveInput, Timer } from 'claude-code'

import { COLUMNS, FRAMES, ROWS } from './sprite'
import type { FrameName } from './sprite'

const PANE = 'snout'
const SPRITE_KEY = 'snout-sprite'
const TICK_MS = 140
const PINK = '#F33682'
const LIGHT_PINK = '#FEA9C9'
const USAGE = 'Usage: /snout [on | off | pink on | pink off | reset]'

// One loop is about 5 seconds: mostly idle, with a blink, a tail wag, a sniff and a little hop.
const TIMELINE: FrameName[] = [
  'idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'idle',
  'blink',
  'idle', 'idle', 'idle', 'idle', 'idle', 'idle',
  'wag', 'idle', 'wag',
  'idle', 'idle', 'idle', 'idle',
  'sniff', 'idle', 'sniff',
  'idle', 'idle', 'idle', 'idle',
  'hop', 'idle', 'hop',
  'idle', 'idle', 'idle', 'idle',
]

// The anteater tongue that flicks after the spinner word.
const TONGUE = ['-', '--', '---', '--']

let line: string | null = null
let characterOn = true
let firstSession = false
let prompted = false
let isWorking = false
let tick = 0
let lastFrame: FrameName = 'idle'
let clock: Timer | null = null
// Sites with a mounted Raster, by requestId: a frame change blits them.
const rasters = new Set<string>()
// Sites drawn as text (Desktop, VS Code): a frame change redraws them.
const textSites = new Set<string>()

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))

function frameNow(): FrameName {
  return TIMELINE.at(tick % TIMELINE.length) ?? 'idle'
}

function forget(requestId: string) {
  rasters.delete(requestId)
  textSites.delete(requestId)
}

async function read($: EngineInterface, path: string) {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

/** Recomputed at session start and after each turn, never while drawing. */
async function refresh($: EngineInterface) {
  const root = (await $.session.root()) || (await $.session.cwd())
  const dir = `${root}/.snout`
  if (!(await $.fs.exists(dir))) return (line = null)
  const session = await $.session.id()
  let saved = 0
  let flagged = 0
  const ledger = await read($, `${dir}/ledger.jsonl`)
  for (const raw of (ledger ?? '').split('\n')) {
    if (!raw.includes(session)) continue
    try {
      const r = JSON.parse(raw)
      // Same rule as the report: a row counts when Snout flagged the content (value 0 or 1).
      if (r.session !== session || !(r.value <= 1) || r.rule === 'unclassified') continue
      if (r.mode === 'enforce' && r.decision !== 'allow') saved += r.tokensAvoidedEst || 0
      else flagged += r.tokensAvoidedEst || 0
    } catch {}
  }
  let cards = 0
  try {
    cards = (await $.fs.list(`${dir}/memory`)).filter(f => {
      const name = String((f as { name?: string }).name ?? f)
      return name.endsWith('.json') && !name.startsWith('preferences')
    }).length
  } catch {}
  let prefs = 0
  try {
    prefs = JSON.parse((await read($, `${dir}/memory/preferences.json`)) ?? '{}').prefs?.length ?? 0
  } catch {}
  const u = await $.session.usage()
  const parts: string[] = []
  if (u?.context?.window && u.context.percent !== undefined) parts.push(`context ${Math.round(u.context.percent)}% of ${fmt(u.context.window)}`)
  parts.push(saved || !flagged ? `saved ~${fmt(saved)} tokens` : `~${fmt(flagged)} tokens flagged (observe)`)
  parts.push(`memory ${cards} session${cards === 1 ? '' : 's'}${prefs ? ` · ${prefs} preference${prefs === 1 ? '' : 's'}` : ''}`)
  line = `snout · ${parts.join(' · ')}`
}

async function update($: EngineInterface) {
  try {
    await refresh($)
    await $.ui.invalidate('ui.render')
  } catch {
    line = null
  }
}

async function themeRow($: EngineInterface): Promise<ConfigRow | undefined> {
  return (await $.config.list()).find(r => r.key === 'theme')
}

function isPink(value: ConfigValue | undefined) {
  return String(value ?? '').includes('snout-pink')
}

async function setTheme($: EngineInterface, candidates: string[]) {
  for (const value of candidates) {
    try {
      if (!(await $.config.set({ key: 'theme', value })).deny) return true
    } catch {
      // The row does not take this spelling: try the next one.
    }
  }
  return false
}

// Turns Snout Pink on once while the pinkTheme switch is on, keeping the theme it replaced. A theme
// the person picks afterwards is left alone. With the switch off, it puts that theme back, unless
// the person has already moved off Snout Pink.
async function syncTheme($: EngineInterface, wantPink: boolean) {
  const row = await themeRow($)
  if (!row || row.isLocked) return
  const applied = Boolean(await $.store.get('themeApplied'))

  if (wantPink && !applied) {
    await $.store.set('themeApplied', true)
    if (isPink(row.value)) return
    await $.store.set('previousTheme', row.value)
    const wantsLight = String(row.value ?? '').includes('light')
    const slug = wantsLight ? 'snout-pink-light' : 'snout-pink'
    const listed = (row.options ?? []).filter(o => o.includes('snout-pink'))
    const match = listed.find(o => o.includes('light') === wantsLight) ?? listed.at(0)
    const ok = await setTheme($, match ? [match] : [`custom:snout:${slug}`, `custom:${slug}`])
    $.ui.toast(ok ? 'Snout Pink is on. /snout pink off puts your theme back.' : 'Pick "Snout Pink" in /theme to go pink.')
  } else if (!wantPink && applied) {
    const previous = await $.store.get('previousTheme')
    await $.store.delete('themeApplied')
    await $.store.delete('previousTheme')
    if (isPink(row.value)) await setTheme($, [typeof previous === 'string' && previous ? previous : 'dark'])
  }
}

// Sets one of this plugin's own /config switches; the engine reloads the module with the new value.
async function setOption($: EngineInterface, field: string, value: boolean) {
  const row = (await $.config.list()).find(r => r.provider.plugin === 'snout' && r.key.endsWith(`.${field}`))
  if (!row) return false
  try {
    return !(await $.config.set({ key: row.key, value })).deny
  } catch {
    return false
  }
}

async function snoutCommand($: EngineInterface, args: string) {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ')
  if (words === '') {
    await $.ui.open({ id: PANE, title: 'Snout', closeOnEscape: true, rows: ROWS + 3 })
    return {}
  }
  if (words === 'on' || words === 'off') {
    characterOn = words === 'on'
    await setOption($, 'character', characterOn)
    await $.ui.invalidate('ui.render')
    return { text: characterOn ? 'Snout is back above the prompt.' : 'Snout is hidden. /snout on brings Snout back; /snout still opens the pane.' }
  }
  if (words === 'pink on' || words === 'pink off') {
    const wantPink = words === 'pink on'
    // Clearing the flag lets "pink on" apply again after the person chose another theme.
    if (wantPink) await $.store.delete('themeApplied')
    await syncTheme($, wantPink)
    await setOption($, 'pinkTheme', wantPink)
    return { text: wantPink ? 'Snout Pink is on.' : 'Snout Pink is off. Your earlier theme is back.' }
  }
  if (words === 'reset') {
    for (const key of ['themeApplied', 'previousTheme', 'welcomeSeen']) await $.store.delete(key)
    return { text: "Restart Claude Code to replay Snout's install." }
  }
  return { text: USAGE }
}

function animate($: EngineInterface) {
  tick += 1
  const frame = frameNow()
  if (frame !== lastFrame) {
    lastFrame = frame
    for (const requestId of rasters) {
      void $.ui.blit({ requestId, key: SPRITE_KEY, cells: FRAMES[frame].cells }).then(r => {
        if (r.deny) rasters.delete(requestId)
      })
    }
    if (textSites.size > 0) $.ui.invalidate('ui.render')
  }
  if (characterOn && isWorking && tick % 2 === 0) $.ui.invalidate('ui.render')
}

// Snout as a Raster in the terminal, as colored text runs elsewhere.
function sprite($: EngineInterface, e: ResolveInput, requestId: string) {
  const els = $.ui.resolve(e)
  const frame = FRAMES[frameNow()]

  if (e.surface === 'terminal' && 'Raster' in els) {
    const { Raster } = els
    rasters.add(requestId)
    textSites.delete(requestId)
    return <Raster key={SPRITE_KEY} columns={COLUMNS} rows={ROWS} cells={frame.cells} />
  }

  const { Box, Text } = els
  rasters.delete(requestId)
  textSites.add(requestId)
  return (
    <Box flexDirection="column">
      {frame.lines.map(runs => (
        <Box flexDirection="row">
          {runs.map(([text, fg, bg]) => (
            <Text mono color={fg ?? undefined} backgroundColor={bg ?? undefined}>
              {text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

function cut(text: string, width: number) {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
}

export const register: Register = (on, options) => {
  characterOn = options.character !== false
  const wantPink = options.pinkTheme !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'snout', description: 'Snout: open the pane, or turn the character or pink theme on or off', argumentHint: '[on|off|pink on|pink off|reset]' })
    firstSession = !(await $.store.get('welcomeSeen'))
    if (firstSession) await $.store.set('welcomeSeen', true)
    await syncTheme($, wantPink)
    clock?.cancel()
    clock = e.isInteractive === false ? null : $.clock.every(TICK_MS, () => animate($))
    await update($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // A slash command (like /snout on) is not the first message: Snout stays up for it.
    if (!e.command) {
      isWorking = true
      if (!prompted) {
        prompted = true
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    isWorking = false
    await update($)
    return next(e)
  })

  on('command.run', { command: 'snout' }, async ($, e) => snoutCommand($, e.args))

  // The status line, and Snout above it until the session's first message. What other mods draw in
  // the band stays under both.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const showSnout = characterOn && !prompted && !e.props.hasSurvey
    if (!showSnout) forget(e.requestId)
    if (!showSnout && !line) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns ?? 80
    const theirs = await next(e)
    const status = line ? <Text dimColor>{cut(line, width)}</Text> : null
    const rows = []

    if (!showSnout) {
      rows.push(status)
    } else if (e.props.maxRows < ROWS + 1 || width < COLUMNS + 30) {
      rows.push(
        <Text>
          <Text color={PINK} bold>Snout</Text> is here. Type /snout to say howdy.
        </Text>,
        status,
      )
    } else {
      const textWidth = width - COLUMNS - 3
      rows.push(
        <Box flexDirection="row" columnGap={3}>
          {sprite($, e, e.requestId)}
          <Box flexDirection="column">
            <Text> </Text>
            <Text> </Text>
            <Text> </Text>
            <Text> </Text>
            <Text color={PINK} bold>{firstSession ? "Howdy, partner. I'm Snout." : 'Howdy, partner.'}</Text>
            <Text color={LIGHT_PINK}>{firstSession ? 'Your terminal just went pink.' : "Snout's on watch."}</Text>
            <Text> </Text>
            <Text dimColor>{cut('/snout opens Snout · /snout off hides Snout', textWidth)}</Text>
            {line ? <Text dimColor>{cut(line, textWidth)}</Text> : null}
          </Box>
        </Box>,
      )
    }
    if (theirs) rows.push(theirs)
    return <Box flexDirection="column">{rows.filter(Boolean)}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" alignItems="center">
        {sprite($, e, e.requestId)}
        <Text color={PINK} bold>Snout</Text>
      </Box>
    )
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    forget(e.id)
    return next(e)
  })

  // While Claude works, Snout's tongue flicks after the spinner word.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!characterOn) return next(e)
    const tongue = TONGUE.at(Math.floor(tick / 2) % TONGUE.length) ?? '-'
    return next({ ...e, props: { ...e.props, suffix: `… ${tongue}>` } })
  })
}
