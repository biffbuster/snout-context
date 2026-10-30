import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ENGINE = { plugin: 'engine', tier: 'core' } as const
const OWN = { plugin: 'snout', tier: 'user' } as const

const BAND = {
  plugin: 'snout',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const TYPED = { kind: 'composer' } as const

// The person typing `/snout <args>`, and a prompt sent from the composer.
const snout = (args: string) =>
  ({ command: 'snout', args, origin: TYPED, presentation: { isFullscreen: false, columns: 120 } }) as const
const prompt = (text: string, command?: { name: string; args: string }) =>
  ({ text, wait: false, origin: TYPED, ...(command ? { command } : {}) }) as const

// Stands in for the engine beneath the plugin: a theme row and the plugin's two switches, each
// change recorded in `sets`. No .snout folder, so the status line stays off.
function engine(on: On, sets: [string, unknown][], theme = 'dark') {
  const rows: { [key: string]: string | boolean; theme: string; 'snout.character': boolean; 'snout.pinkTheme': boolean } = {
    theme,
    'snout.character': true,
    'snout.pinkTheme': true,
  }
  on('command.register', () => ({ value: { command: 'snout' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('config.list', () => ({
    value: [
      {
        key: 'theme', label: 'Theme', kind: 'choice', value: rows.theme, isLocked: false, provider: ENGINE,
        options: ['dark', 'light', 'custom:snout:snout-pink', 'custom:snout:snout-pink-light'],
      },
      { key: 'snout.character', label: 'Show Snout', kind: 'boolean', value: rows['snout.character'], isLocked: false, provider: OWN },
      { key: 'snout.pinkTheme', label: 'Snout Pink theme', kind: 'boolean', value: rows['snout.pinkTheme'], isLocked: false, provider: OWN },
    ],
  }))
  on('config.set', (_, e) => {
    rows[e.key] = e.value as string | boolean
    sets.push([e.key, e.value])
    return { value: e.value }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  // What the engine (or another mod) draws in the band: Snout keeps it, under its own rows.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

test('first load switches to Snout Pink once', async ($, on) => {
  const sets: [string, unknown][] = []
  mock.clock(on)
  mock.store(on)
  engine(on, sets)

  await $.session.start(START)
  expect(sets).toEqual([['theme', 'custom:snout:snout-pink']])

  // A later session leaves the person's theme alone.
  await $.session.start(START)
  expect(sets).toEqual([['theme', 'custom:snout:snout-pink']])
})

test('a light theme gets the light pink', async ($, on) => {
  const sets: [string, unknown][] = []
  mock.clock(on)
  mock.store(on)
  engine(on, sets, 'light')
  await $.session.start(START)
  expect(sets).toEqual([['theme', 'custom:snout:snout-pink-light']])
})

test('/snout pink off puts the old theme back and turns the switch off', async ($, on) => {
  const sets: [string, unknown][] = []
  mock.clock(on)
  mock.store(on)
  engine(on, sets)
  await $.session.start(START)

  const { text } = await $.command.run(snout('pink off'))
  expect(text).toMatch(/earlier theme is back/)
  expect(sets).toEqual([
    ['theme', 'custom:snout:snout-pink'],
    ['theme', 'dark'],
    ['snout.pinkTheme', false],
  ])
})

test('with the pink switch off, the theme is never touched', { options: { pinkTheme: false } }, async ($, on) => {
  const sets: [string, unknown][] = []
  mock.clock(on)
  mock.store(on)
  engine(on, sets)
  await $.session.start(START)
  expect(sets).toEqual([])
})

test('Snout draws as a Raster in the terminal and as text on the desktop', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  engine(on, [])

  for (const surface of ['terminal', 'desktop'] as const) {
    await $.session.start({ ...START, surface })
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(Boolean(await ui.find({ type: 'Raster' }))).toBe(surface === 'terminal')
    expect((await ui.find({ type: 'Text', text: /Howdy, partner/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await ui.unmount()
  }
})

test('Snout stays up for a slash command and leaves at the first message', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  engine(on, [])
  await $.session.start(START)

  await $.prompt.submit(prompt('/help', { name: 'help', args: '' }))
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeTruthy()
  await ui.unmount()

  await $.prompt.submit(prompt('fix the failing test'))
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeFalsy()
  await ui.unmount()
})

test('/snout off hides Snout and turns the switch off', async ($, on) => {
  const sets: [string, unknown][] = []
  mock.clock(on)
  mock.store(on, { themeApplied: true, welcomeSeen: true })
  engine(on, sets)
  await $.session.start(START)

  const { text } = await $.command.run(snout('off'))
  expect(text).toMatch(/hidden/)
  expect(sets).toEqual([['snout.character', false]])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeFalsy()
  await ui.unmount()
})

test('with the character switch off, Snout is not drawn',{ options: { character: false } }, async ($, on) => {
  mock.clock(on)
  mock.store(on, { themeApplied: true })
  engine(on, [])
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('/snout reset replays the install on the next session', async ($, on) => {
  const sets: [string, unknown][] = []
  mock.clock(on)
  mock.store(on, { themeApplied: true, welcomeSeen: true })
  engine(on, sets)
  await $.session.start(START)
  expect(sets).toEqual([])

  const { text } = await $.command.run(snout('reset'))
  expect(text).toMatch(/Restart Claude Code/)
  await $.session.start(START)
  expect(sets).toEqual([['theme', 'custom:snout:snout-pink']])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /I'm Snout/ }))?.text).toBeTruthy()
  await ui.unmount()
})
