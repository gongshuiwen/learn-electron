import { app, dialog } from 'electron'
import log from 'electron-log/main'
import electronUpdater from 'electron-updater'

export async function checkForAppUpdates(): Promise<void> {
  if (!app.isPackaged || process.platform !== 'win32') return

  const { autoUpdater } = electronUpdater
  autoUpdater.logger = log
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  const result = await autoUpdater.checkForUpdates()
  if (!result?.isUpdateAvailable) return

  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: '应用更新',
    message: `发现新版本 ${result.updateInfo.version}，是否下载？`,
    detail: '下载期间可以继续使用应用，完成后会提示重启安装。',
    buttons: ['下载更新', '稍后再说'],
    defaultId: 1,
    cancelId: 1,
  })
  if (response !== 0) return

  try {
    await autoUpdater.downloadUpdate()
  } catch {
    // electron-updater already records download errors through its logger.
    await dialog.showMessageBox({
      type: 'warning',
      title: '更新下载失败',
      message: '未能下载更新，请稍后重新启动应用重试。',
    })
    return
  }

  const install = await dialog.showMessageBox({
    type: 'info',
    title: '更新已就绪',
    message: '更新已下载，是否立即重启安装？',
    detail: '请先保存正在进行的工作。选择稍后安装，下次启动时会再次检查更新。',
    buttons: ['重启安装', '稍后安装'],
    defaultId: 1,
    cancelId: 1,
  })
  if (install.response === 0) autoUpdater.quitAndInstall()
}
