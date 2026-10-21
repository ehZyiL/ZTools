/**
 * 非 macOS 平台上 Electron 可解析的修饰键名称映射。
 * 键为小写别名，值为 Linux/Windows 下 globalShortcut 能识别的规范名称。
 */
const NON_MACOS_MODIFIER_ALIASES: Record<string, string> = {
  option: 'Alt',
  alt: 'Alt',
  command: 'Super',
  cmd: 'Super',
  super: 'Super',
  meta: 'Super',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  shift: 'Shift'
}

/**
 * 判断当前进程是否运行在 Linux 原生 Wayland 会话中。
 *
 * @returns 处于 Wayland 会话时返回 true；其它平台或会话返回 false。
 */
export function isWaylandSession(): boolean {
  if (process.platform !== 'linux') return false
  return process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY)
}

/**
 * 将快捷键改写为当前平台可注册的 Electron 加速器。
 *
 * macOS 风格名称（Option/Command）在 Linux 与 Windows 上无法解析，
 * 会让 globalShortcut.register 直接返回 false，因此注册前必须统一修饰键名称。
 *
 * @param shortcut 用户配置或内置默认的快捷键字符串，例如 Option+Z。
 * @param targetPlatform 目标平台，默认取当前进程平台。
 * @returns 可直接交给 globalShortcut 注册的加速器字符串。
 */
export function normalizeShortcutAccelerator(
  shortcut: string,
  targetPlatform: NodeJS.Platform = process.platform
): string {
  // macOS 原生支持 Option/Command 名称，保持原样避免影响既有配置。
  if (!shortcut || targetPlatform === 'darwin') return shortcut

  const parts = shortcut.split('+').map((part) => {
    const trimmed = part.trim()
    return NON_MACOS_MODIFIER_ALIASES[trimmed.toLowerCase()] ?? trimmed
  })
  return parts.join('+')
}
