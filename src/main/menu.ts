import { dirname } from 'node:path'
import { app, dialog, Menu, shell, Tray } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import log from 'electron-log/main'
import { checkForAppUpdates } from './updater'

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

async function openLogsDirectory(): Promise<void> {
  try {
    const error = await shell.openPath(dirname(log.transports.file.getFile().path))
    if (error) throw new Error(error)
  } catch (error) {
    log.error('Unable to open logs directory:', error)
    dialog.showErrorBox('无法打开日志目录', '请检查日志目录是否存在以及访问权限。')
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
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: process.platform === 'darwin' ? app.getName() : '应用',
        submenu: [
          { role: 'about', label: '关于' },
          { type: 'separator' },
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
              void openLogsDirectory()
            },
          },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ],
      },
      { role: 'editMenu', label: '编辑' },
      { role: 'viewMenu', label: '视图' },
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
}
