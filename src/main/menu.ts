import { dirname } from 'node:path'
import { app, dialog, Menu, shell, Tray } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import log from 'electron-log/main'
import { checkForAppUpdates } from './updater'
import { resetWindowLayout } from './window-state'

export function createTray(window: BrowserWindow, icon: string): void {
  if (process.platform !== 'win32') return
  const tray = new Tray(icon)
  const showWindow = (): void => {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  tray.setToolTip(app.getName())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: showWindow },
      { label: '隐藏窗口', click: () => window.hide() },
      { type: 'separator' },
      {
        label: '退出应用',
        click: () => {
          showWindow()
          app.quit()
        },
      },
    ]),
  )
  tray.on('click', showWindow)
  // This listener retains the tray until its window is actually closed.
  window.once('closed', () => tray.destroy())
}

export function registerContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    if (!params.frame || (!params.isEditable && !params.selectionText)) return
    const { editFlags } = params
    const items: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: 'undo', label: '撤销', enabled: editFlags.canUndo },
          { role: 'redo', label: '重做', enabled: editFlags.canRedo },
          { type: 'separator' },
          { role: 'cut', label: '剪切', enabled: editFlags.canCut },
          { role: 'copy', label: '复制', enabled: editFlags.canCopy },
          { role: 'paste', label: '粘贴', enabled: editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll', label: '全选', enabled: editFlags.canSelectAll },
        ]
      : [{ role: 'copy', label: '复制', enabled: editFlags.canCopy }]
    Menu.buildFromTemplate(items).popup({
      window,
      frame: params.frame,
      sourceType: params.menuSourceType,
    })
  })
}

async function openDirectory(path: string, label: string): Promise<void> {
  try {
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  } catch (error) {
    log.error(`Unable to open directory (${path}):`, error)
    dialog.showErrorBox(`无法打开${label}`, `请检查${label}是否存在以及访问权限。`)
  }
}

async function openHelpPage(url: string): Promise<void> {
  try {
    await shell.openExternal(url)
  } catch (error) {
    log.error('Unable to open help page:', error)
    dialog.showErrorBox('无法打开网页', '请检查默认浏览器设置后重试。')
  }
}

export function createApplicationMenu(): void {
  const launchAtLogin: MenuItemConstructorOptions = {
    id: 'launch-at-login',
    label: '开机启动',
    type: 'checkbox',
    visible: process.platform === 'win32',
    enabled: process.platform === 'win32' && app.isPackaged,
    checked:
      process.platform === 'win32' &&
      app.isPackaged &&
      app.getLoginItemSettings().executableWillLaunchAtLogin,
    click: (item) => {
      try {
        app.setLoginItemSettings({ openAtLogin: item.checked })
        if (app.getLoginItemSettings().executableWillLaunchAtLogin !== item.checked) {
          throw new Error('Login item setting did not take effect')
        }
      } catch (error) {
        item.checked = !item.checked
        log.error('Unable to change launch at login:', error)
        dialog.showErrorBox('无法修改开机启动', '请检查 Windows 启动应用设置后重试。')
      }
    },
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: process.platform === 'darwin' ? app.getName() : '应用',
        submenu: [
          { role: 'about', label: '关于' },
          { type: 'separator' },
          launchAtLogin,
          {
            id: 'check-for-updates',
            label: '检查更新…',
            click: () => {
              void checkForAppUpdates(true)
            },
          },
          {
            id: 'open-logs',
            label: '打开日志目录',
            click: () => {
              void openDirectory(dirname(log.transports.file.getFile().path), '日志目录')
            },
          },
          {
            id: 'open-config',
            label: '打开配置目录',
            click: () => {
              void openDirectory(app.getPath('userData'), '配置目录')
            },
          },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ],
      },
      { role: 'editMenu', label: '编辑' },
      {
        label: '视图',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          {
            id: 'reset-window-layout',
            label: '恢复默认窗口布局',
            click: (_item, window) => {
              if (window) resetWindowLayout(window)
            },
          },
        ],
      },
      {
        role: 'help',
        label: '帮助',
        submenu: [
          {
            id: 'project-homepage',
            label: '项目主页',
            click: () => {
              void openHelpPage('https://github.com/gongshuiwen/learn-electron')
            },
          },
          {
            id: 'report-issue',
            label: '问题反馈',
            click: () => {
              void openHelpPage('https://github.com/gongshuiwen/learn-electron/issues')
            },
          },
        ],
      },
    ]),
  )
  const loginItem = Menu.getApplicationMenu()?.getMenuItemById('launch-at-login')
  if (loginItem?.enabled) {
    app.on('browser-window-focus', () => {
      loginItem.checked = app.getLoginItemSettings().executableWillLaunchAtLogin
    })
  }
}
