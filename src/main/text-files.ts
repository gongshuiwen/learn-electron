import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import type { TextFile } from '../shared/ipc'

const MAX_TEXT_BYTES = 1024 * 1024
const filters = [{ name: '文本文件', extensions: ['txt', 'md', 'json'] }]

export async function openTextFile(window: BrowserWindow): Promise<TextFile | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: '打开文本文件',
    properties: ['openFile'],
    filters,
  })
  const path = filePaths[0]
  if (canceled || !path) return null
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
  return basename(filePath)
}
