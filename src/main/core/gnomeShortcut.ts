import { execFileSync } from 'child_process'

/** GNOME 媒体键 schema，自定义快捷键列表挂在这个 schema 下 */
const MEDIA_KEYS_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys'
/** 单条自定义快捷键的 schema，需要拼接具体路径使用 */
const CUSTOM_KEYBINDING_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding'
/** ZTools 独占的自定义快捷键路径，便于重复写入时覆盖而不是不断新增 */
const ZTOOLS_KEYBINDING_PATH =
  '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/ztools/'

/** Electron 修饰键到 GNOME 键位描述符的映射 */
const GNOME_MODIFIER_MAP: Record<string, string> = {
  alt: '<Alt>',
  option: '<Alt>',
  ctrl: '<Control>',
  control: '<Control>',
  shift: '<Shift>',
  super: '<Super>',
  command: '<Super>',
  cmd: '<Super>',
  meta: '<Super>'
}

/** 具名按键到 GNOME keysym 名称的映射 */
const GNOME_KEY_ALIASES: Record<string, string> = {
  space: 'space',
  spacebar: 'space',
  escape: 'Escape',
  esc: 'Escape',
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  backspace: 'BackSpace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Page_Up',
  pagedown: 'Page_Down',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  '`': 'grave',
  '-': 'minus',
  '=': 'equal',
  '[': 'bracketleft',
  ']': 'bracketright',
  '\\': 'backslash',
  ';': 'semicolon',
  "'": 'apostrophe',
  ',': 'comma',
  '.': 'period',
  '/': 'slash'
}

/**
 * 判断当前桌面环境是否为 GNOME。
 *
 * @returns 当前会话为 GNOME 桌面时返回 true。
 */
export function isGnomeSession(): boolean {
  if (process.platform !== 'linux') return false
  const desktop = process.env.XDG_CURRENT_DESKTOP || ''
  return desktop.toUpperCase().includes('GNOME') || Boolean(process.env.GNOME_DESKTOP_SESSION_ID)
}

/**
 * 把 Electron 加速器转换为 GNOME 键位描述，例如 Alt+Z 转换为 <Alt>z。
 *
 * @param accelerator Electron 加速器字符串，例如 Alt+Z。
 * @returns GNOME 键位描述；无法转换时返回 null。
 */
export function toGnomeBinding(accelerator: string): string | null {
  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  // 至少需要一个修饰键加一个主键，否则 GNOME 侧无法作为全局快捷键使用。
  if (parts.length < 2) return null

  const keyPart = parts.pop() as string
  const modifiers: string[] = []
  for (const part of parts) {
    const modifier = GNOME_MODIFIER_MAP[part.toLowerCase()]
    if (!modifier) return null
    modifiers.push(modifier)
  }

  const key = normalizeGnomeKey(keyPart)
  if (!key) return null
  return `${modifiers.join('')}${key}`
}

/**
 * 归一化主键名称，兼容单字符、功能键和常见符号键。
 *
 * @param keyPart 加速器中的主键片段。
 * @returns GNOME keysym 名称；不支持时返回 null。
 */
function normalizeGnomeKey(keyPart: string): string | null {
  const lower = keyPart.toLowerCase()
  if (GNOME_KEY_ALIASES[lower]) return GNOME_KEY_ALIASES[lower]
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase()
  if (/^[a-z0-9]$/.test(lower)) return lower
  return null
}

/**
 * 调用 gsettings 读取或写入配置。
 *
 * @param args gsettings 参数列表。
 * @returns 命令标准输出；写入类命令返回空字符串。
 * @throws gsettings 执行失败或超时时抛出。
 */
function runGsettings(args: string[]): string {
  return execFileSync('gsettings', args, { encoding: 'utf8', timeout: 5000 }).trim()
}

/**
 * 读取已有的自定义快捷键路径列表。
 *
 * @returns 已注册的自定义快捷键路径数组；读取失败时返回空数组。
 */
function readCustomKeybindingPaths(): string[] {
  try {
    const raw = runGsettings(['get', MEDIA_KEYS_SCHEMA, 'custom-keybindings'])
    return raw.match(/'[^']+'/g)?.map((item) => item.slice(1, -1)) ?? []
  } catch {
    return []
  }
}

/**
 * 将路径数组序列化为 gsettings 的字符串数组字面量。
 *
 * @param paths 自定义快捷键路径数组。
 * @returns 形如 ['/a/', '/b/'] 的 gsettings 取值。
 */
function formatKeybindingPaths(paths: string[]): string {
  return `[${paths.map((item) => `'${item}'`).join(', ')}]`
}

/**
 * 安装或更新 ZTools 的 GNOME 自定义快捷键。
 *
 * GNOME Wayland 下 Electron 无法通过 X11 抓键获取全局按键，只能由桌面环境
 * 自己绑定快捷键并执行命令，因此这里把快捷键写进 GNOME 的自定义快捷键列表。
 *
 * @param accelerator Electron 加速器字符串，例如 Alt+Z。
 * @param command 快捷键触发时执行的命令。
 * @returns 写入成功返回 true；不支持的键位或 gsettings 调用失败返回 false。
 */
export function installGnomeCustomShortcut(accelerator: string, command: string): boolean {
  const binding = toGnomeBinding(accelerator)
  if (!binding) {
    console.warn(`[GnomeShortcut] 无法转换为 GNOME 键位描述: ${accelerator}`)
    return false
  }

  try {
    // 先确保路径已登记到全局列表，避免后续单条配置写不生效。
    const paths = readCustomKeybindingPaths()
    if (!paths.includes(ZTOOLS_KEYBINDING_PATH)) {
      runGsettings([
        'set',
        MEDIA_KEYS_SCHEMA,
        'custom-keybindings',
        formatKeybindingPaths([...paths, ZTOOLS_KEYBINDING_PATH])
      ])
    }

    // 单条快捷键的三个字段必须同时存在，GNOME 才会真正启用该绑定。
    const schemaWithPath = `${CUSTOM_KEYBINDING_SCHEMA}:${ZTOOLS_KEYBINDING_PATH}`
    runGsettings(['set', schemaWithPath, 'name', 'ZTools'])
    runGsettings(['set', schemaWithPath, 'command', command])
    runGsettings(['set', schemaWithPath, 'binding', binding])

    console.log(`[GnomeShortcut] 已写入 GNOME 自定义快捷键: ${binding} -> ${command}`)
    return true
  } catch (error) {
    console.error('[GnomeShortcut] 写入 GNOME 自定义快捷键失败:', error)
    return false
  }
}

/**
 * 移除 ZTools 的 GNOME 自定义快捷键。
 *
 * @returns 无返回值；gsettings 调用失败时仅记录日志。
 */
export function removeGnomeCustomShortcut(): void {
  try {
    const paths = readCustomKeybindingPaths()
    if (!paths.includes(ZTOOLS_KEYBINDING_PATH)) return

    runGsettings([
      'set',
      MEDIA_KEYS_SCHEMA,
      'custom-keybindings',
      formatKeybindingPaths(paths.filter((item) => item !== ZTOOLS_KEYBINDING_PATH))
    ])
    console.log('[GnomeShortcut] 已移除 GNOME 自定义快捷键')
  } catch (error) {
    console.error('[GnomeShortcut] 移除 GNOME 自定义快捷键失败:', error)
  }
}
