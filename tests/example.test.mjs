import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'
import { _electron as electron } from 'playwright-core'

// These checks belong to the starter page and can be removed along with it.
test('Starter page interactions, text files and theme', { timeout: 30000 }, async (t) => {
  const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const profile = await mkdtemp(join(tmpdir(), 'learn-electron-example-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let desktop
  t.after(async () => {
    try {
      await desktop?.close()
    } finally {
      await rm(profile, { recursive: true, force: true })
    }
  })
  desktop = await electron.launch({
    args: [root, `--user-data-dir=${profile}`],
    cwd: root,
    chromiumSandbox: true,
    env,
    timeout: 15000,
  })
  const page = await desktop.firstWindow()
  // Let Electron's native theme drive media queries instead of Playwright's default.
  await page.emulateMedia({ colorScheme: null })
  page.setDefaultTimeout(5000)
  await page.getByRole('heading', { name: '从这里开始，构建桌面应用。' }).waitFor()
  await page.getByRole('button', { name: '点击次数：0' }).click()
  await page.getByRole('button', { name: '点击次数：1' }).waitFor()
  await page.getByRole('button', { name: '读取应用信息' }).click()
  await page.getByText(`${manifest.name} ${manifest.version}`, { exact: true }).waitFor()

  // Capture clipboard writes inside this test app without changing the user's clipboard.
  const clipboardSpy = await desktop.evaluateHandle(({ clipboard }) => {
    const state = { text: '', fail: false, calls: 0 }
    clipboard.writeText = async (text) => {
      state.calls += 1
      if (state.fail) throw new Error('Clipboard unavailable')
      state.text = text
    }
    return state
  })
  const info = await page.evaluate(() => window.electronAPI.getAppInfo())
  await page.getByText(info.os, { exact: true }).waitFor()
  await page.getByText(info.arch, { exact: true }).waitFor()
  const copyButton = page.getByRole('button', { name: '复制诊断信息', exact: true })
  await copyButton.click()
  await page.getByRole('status').filter({ hasText: '已复制诊断信息。' }).waitFor()
  assert.equal(
    await clipboardSpy.evaluate((state) => state.text),
    [
      `应用: ${manifest.name} ${manifest.version}`,
      `Electron: ${info.electron}`,
      `Chromium: ${info.chrome}`,
      `Node.js: ${info.node}`,
      `系统: ${info.os}`,
      `架构: ${info.arch}`,
    ].join('\n'),
  )
  await clipboardSpy.evaluate((state) => {
    state.fail = true
  })
  await copyButton.click()
  await page.getByRole('alert').filter({ hasText: '复制失败，请重试。' }).waitFor()
  assert.equal(await page.getByText('已复制诊断信息。', { exact: true }).count(), 0)
  await clipboardSpy.evaluate((state) => {
    state.fail = false
  })
  await copyButton.click()
  await page.getByRole('status').filter({ hasText: '已复制诊断信息。' }).waitFor()
  assert.equal(await page.getByRole('alert').count(), 0)
  assert.equal(await clipboardSpy.evaluate((state) => state.calls), 3)

  // Stub only native file selection; exercise the real preload, IPC and file IO.
  async function chooseFiles(openPath, savePath) {
    await desktop.evaluate(
      ({ dialog }, paths) => {
        dialog.showOpenDialog = async () => ({
          canceled: paths.openPath === null,
          filePaths: paths.openPath === null ? [] : [paths.openPath],
        })
        dialog.showSaveDialog = async () => ({
          canceled: paths.savePath === null,
          filePath: paths.savePath ?? '',
        })
      },
      { openPath, savePath },
    )
  }
  const inputFile = join(profile, '输入.txt')
  const outputFile = join(profile, '另存为.txt')
  const originalText = 'UTF-8 文本：你好 🌍\n第二行'
  await writeFile(inputFile, originalText, 'utf8')
  await chooseFiles(inputFile, outputFile)
  const editor = page.getByRole('textbox', { name: /^文件内容/ })
  await page.getByRole('button', { name: '打开文本文件', exact: true }).click()
  await page.getByLabel('文件内容 · 输入.txt', { exact: true }).waitFor()
  assert.equal(await editor.inputValue(), originalText)
  const editedText = `${originalText}\n已编辑`
  await editor.fill(editedText)
  await page.getByRole('button', { name: '另存为', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已保存：另存为.txt' }).waitFor()
  assert.equal(await readFile(outputFile, 'utf8'), editedText)
  assert.equal(await readFile(inputFile, 'utf8'), originalText)

  // Canceling either dialog must preserve the buffer and leave files untouched.
  await editor.fill('尚未保存的内容')
  await chooseFiles(null, null)
  await page.getByRole('button', { name: '打开文本文件', exact: true }).click()
  await page.getByRole('button', { name: '另存为', exact: true }).click()
  await page.waitForFunction(() => !window.document.querySelector('#text-file-content').disabled)
  assert.equal(await editor.inputValue(), '尚未保存的内容')
  assert.equal(await readFile(outputFile, 'utf8'), editedText)
  assert.equal(await page.getByRole('alert').count(), 0)

  // Empty text is a valid document, including when replacing an existing file.
  await chooseFiles(inputFile, outputFile)
  await editor.fill('')
  await page.getByRole('button', { name: '另存为', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已保存：另存为.txt' }).waitFor()
  assert.equal(await readFile(outputFile, 'utf8'), '')

  await editor.fill('失败时保留的内容')
  const invalidFile = join(profile, 'invalid.txt')
  const largeFile = join(profile, 'large.txt')
  await writeFile(invalidFile, new Uint8Array([0xff]))
  await writeFile(largeFile, 'x'.repeat(1024 * 1024 + 1))
  for (const path of [join(profile, 'missing.txt'), invalidFile, largeFile]) {
    await chooseFiles(path, profile)
    await page.getByRole('button', { name: '打开文本文件', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '无法打开文件' }).waitFor()
    assert.equal(await editor.inputValue(), '失败时保留的内容')
  }
  // A directory cannot be used as the output file.
  await page.getByRole('button', { name: '另存为', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '无法保存文件' }).waitFor()
  assert.equal(await editor.inputValue(), '失败时保留的内容')
  await assert.rejects(
    page.evaluate(() => window.electronAPI.saveTextFile(42)),
    /Expected text/,
  )
  await assert.rejects(
    page.evaluate(() => window.electronAPI.saveTextFile('文'.repeat(400000))),
    /Expected text/,
  )
  const rendererURL = page.url()
  await page.evaluate(() => window.history.replaceState(null, '', '?untrusted=1'))
  await assert.rejects(
    page.evaluate(() => window.electronAPI.openTextFile()),
    /Unexpected IPC sender/,
  )
  await assert.rejects(
    page.evaluate(() => window.electronAPI.saveTextFile('text')),
    /Unexpected IPC sender/,
  )
  await assert.rejects(
    page.evaluate(() => window.electronAPI.copyDiagnostics()),
    /Unexpected IPC sender/,
  )
  assert.equal(await clipboardSpy.evaluate((state) => state.calls), 3)
  await clipboardSpy.dispose()
  await page.evaluate((url) => window.history.replaceState(null, '', url), rendererURL)

  const theme = page.getByLabel('主题', { exact: true })
  await theme.selectOption('dark')
  await page.waitForFunction(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const darkBackground = await page
    .locator('body')
    .evaluate((element) => window.getComputedStyle(element).backgroundColor)
  await theme.selectOption('light')
  await page.waitForFunction(() => !window.matchMedia('(prefers-color-scheme: dark)').matches)
  const lightBackground = await page
    .locator('body')
    .evaluate((element) => window.getComputedStyle(element).backgroundColor)
  assert.notEqual(darkBackground, lightBackground)

  // An unwritable preference must leave the current theme intact and show an error.
  const settingsFile = join(profile, 'settings.json')
  await rm(settingsFile)
  await mkdir(settingsFile)
  await theme.selectOption('dark')
  await page.getByRole('alert').filter({ hasText: '主题设置未能保存，请重试。' }).waitFor()
  assert.equal(await theme.inputValue(), 'light')
  assert.equal(await page.evaluate(() => window.electronAPI.getTheme()), 'light')
})
