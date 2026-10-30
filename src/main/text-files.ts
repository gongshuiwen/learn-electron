import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import type { TextFile } from '../shared/ipc'

const MAX_TEXT_BYTES = 1024 * 1024
const filters = [{ name: '文本文件', extensions: ['txt', 'md', 'json'] }]
const savedFiles = new WeakMap<BrowserWindow, string>()

export function confirmDiscardChanges(window: BrowserWindow): boolean {
  return (
    dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: '未保存修改',
      message: '有未保存的修改，是否放弃？',
      buttons: ['取消', '放弃修改'],
      defaultId: 0,
      cancelId: 0,
    }) === 1
  )
}

export async function openTextFile(
  window: BrowserWindow,
  hasUnsavedChanges: unknown,
  droppedPath?: unknown,
): Promise<TextFile | null> {
  if (typeof hasUnsavedChanges !== 'boolean') throw new Error('Expected an unsaved changes flag')
  if (droppedPath !== undefined && (typeof droppedPath !== 'string' || !droppedPath)) {
    throw new Error('Expected a dropped file path')
  }
  if (hasUnsavedChanges && !confirmDiscardChanges(window)) return null
  let path = droppedPath
  if (path === undefined) {
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: '打开文本文件',
      properties: ['openFile'],
      filters,
    })
    path = filePaths[0]
    if (canceled || !path) return null
  }
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_TEXT_BYTES) {
    throw new Error('Choose a text file no larger than 1 MiB')
  }
  const content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))
  return { name: basename(path), content }
}

export async function saveTextFile(
  window: BrowserWindow,
  content: unknown,
): Promise<string | null> {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) {
    throw new Error('Expected text no larger than 1 MiB')
  }
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: '文本另存为',
    defaultPath: '未命名.txt',
    filters,
    properties: ['showOverwriteConfirmation'],
  })
  if (canceled || !filePath) return null
  await writeFile(filePath, content, 'utf8')
  savedFiles.set(window, filePath)
  return basename(filePath)
}

export async function showSavedFile(window: BrowserWindow): Promise<void> {
  const path = savedFiles.get(window)
  if (!path) throw new Error('No saved file for this window')
  if (!(await stat(path)).isFile()) throw new Error('Saved file is no longer a regular file')
  shell.showItemInFolder(path)
}
