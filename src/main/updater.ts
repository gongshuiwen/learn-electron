import { app, BrowserWindow, dialog } from 'electron'
import log from 'electron-log/main'
import electronUpdater from 'electron-updater'

let updateInProgress = false

function setDownloadProgress(progress: number): void {
  for (const window of BrowserWindow.getAllWindows()) window.setProgressBar(progress)
}

export function checkForAppUpdates(manual = false): Promise<void> {
  return runUpdateCheck(manual).catch((error: unknown) => {
    log.error('Unable to check for application updates:', error)
    if (manual) {
      dialog.showErrorBox('检查更新失败', '暂时无法获取更新信息，请检查网络连接后重试。')
    }
  })
}

async function runUpdateCheck(manual: boolean): Promise<void> {
  if (updateInProgress) {
    if (manual) {
      await dialog.showMessageBox({
        type: 'info',
        title: '应用更新',
        message: '正在检查或下载更新，请稍候。',
      })
    }
    return
  }

  updateInProgress = true
  try {
    if (!app.isPackaged || process.platform !== 'win32') {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: '应用更新',
          message: '自动更新仅支持 Windows 打包版本，开发模式不检查更新。',
        })
      }
      return
    }

    const { autoUpdater } = electronUpdater
    autoUpdater.logger = log
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    const result = await autoUpdater.checkForUpdates()
    if (!result?.isUpdateAvailable) {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: '应用更新',
          message: `当前已是最新版本（${app.getVersion()}）。`,
        })
      }
      return
    }

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
      const onProgress = ({ percent }: { percent: number }): void => {
        setDownloadProgress(percent / 100)
      }
      autoUpdater.on('download-progress', onProgress)
      try {
        setDownloadProgress(2)
        await autoUpdater.downloadUpdate()
      } finally {
        autoUpdater.off('download-progress', onProgress)
        setDownloadProgress(-1)
      }
    } catch {
      // electron-updater already records download errors through its logger.
      await dialog.showMessageBox({
        type: 'warning',
        title: '更新下载失败',
        message: '未能下载更新，请稍后从“应用 → 检查更新”重试。',
      })
      return
    }

    const install = await dialog.showMessageBox({
      type: 'info',
      title: '更新已就绪',
      message: '更新已下载，是否立即重启安装？',
      detail: '请先保存正在进行的工作。选择稍后安装，可从“应用 → 检查更新”再次操作。',
      buttons: ['重启安装', '稍后安装'],
      defaultId: 1,
      cancelId: 1,
    })
    if (install.response === 0) autoUpdater.quitAndInstall()
  } finally {
    updateInProgress = false
  }
}
