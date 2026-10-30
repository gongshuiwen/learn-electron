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

  // Exercise native notification events without posting real desktop notifications.
  const notificationSpy = await desktop.evaluateHandle(({ Notification }) => {
    const state = { supported: false, mode: 'show', calls: 0, closed: 0, notification: null }
    Notification.isSupported = () => state.supported
    Notification.prototype.close = function () {
      state.closed += 1
    }
    Notification.prototype.show = function () {
      state.calls += 1
      state.notification = this
      if (state.mode === 'throw') throw new Error('Native notification error')
      if (state.mode === 'show') this.emit('show', {})
      if (state.mode === 'failed') {
        void Promise.resolve().then(() => this.emit('failed', {}, 'Notifications disabled'))
      }
    }
    return state
  })
  const notifyButton = page.getByRole('button', { name: '发送系统通知', exact: true })
  await notifyButton.click()
  await page.getByRole('status').filter({ hasText: '当前系统不支持通知。' }).waitFor()
  assert.equal(await notificationSpy.evaluate((state) => state.calls), 0)
  await notificationSpy.evaluate((state) => {
    state.supported = true
  })
  await notifyButton.click()
  await page.getByRole('status').filter({ hasText: '通知已交给系统' }).waitFor()
  assert.deepEqual(
    await notificationSpy.evaluate((state) => ({
      title: state.notification.title,
      body: state.notification.body,
    })),
    { title: '系统通知', body: '这是一条示例通知，点击可返回应用。' },
  )
  await desktop.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (process.platform === 'linux') {
      win.hide()
    } else {
      await new Promise((resolve) => {
        win.once('minimize', resolve)
        win.minimize()
      })
    }
  })
  await notificationSpy.evaluate((state) => state.notification.emit('click', {}))
  assert.deepEqual(
    await desktop.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return { visible: win.isVisible(), minimized: win.isMinimized() }
    }),
    { visible: true, minimized: false },
  )
  for (const mode of ['failed', 'throw', 'timeout']) {
    await notificationSpy.evaluate((state, value) => {
      state.mode = value
    }, mode)
    await notifyButton.click()
    await page
      .getByRole('alert')
      .filter({ hasText: '未能发送或确认通知' })
      .waitFor({ timeout: 8000 })
    assert.equal(await page.getByRole('status').filter({ hasText: '通知已交给系统' }).count(), 0)
  }
  await notificationSpy.evaluate((state) => {
    state.mode = 'show'
  })
  await notifyButton.click()
  await page.getByRole('status').filter({ hasText: '通知已交给系统' }).waitFor()
  assert.equal(await page.getByRole('alert').count(), 0)
  assert.equal(await notificationSpy.evaluate((state) => state.closed), 4)
  await assert.rejects(
    page.evaluate(() => window.electronAPI.showNotification(' ', 'body')),
    /Expected a notification title and body/,
  )
  await assert.rejects(
    page.evaluate(() => window.electronAPI.showNotification('title', 42)),
    /Expected a notification title and body/,
  )

  const discardDialog = await desktop.evaluateHandle(({ dialog }) => {
    const state = { response: 1, calls: 0, options: null }
    dialog.showMessageBoxSync = (_window, options) => {
      state.calls += 1
      state.options = options
      return state.response
    }
    return state
  })
  // Stub native dialogs; exercise the real preload, IPC and file IO.
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
  async function dropFiles(paths) {
    // Obtain disk-backed File objects, so the real preload can resolve their paths.
    await page.evaluate(() => {
      const input = window.document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.hidden = true
      input.id = 'drop-fixture'
      window.document.body.append(input)
    })
    await page.locator('#drop-fixture').setInputFiles(paths)
    await page.evaluate(() => {
      const input = window.document.querySelector('#drop-fixture')
      const dataTransfer = new window.DataTransfer()
      for (const file of input.files) dataTransfer.items.add(file)
      window.document
        .querySelector('#text-file-content')
        .dispatchEvent(
          new window.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
        )
      input.remove()
    })
    await page.waitForFunction(() => !window.document.querySelector('#text-file-content').disabled)
  }
  const outputFile = join(profile, '另存为.txt')
  const originalText = 'UTF-8 文本：你好 🌍\n第二行'
  await writeFile(inputFile, originalText, 'utf8')
  await chooseFiles(inputFile, outputFile)
  const editor = page.getByRole('textbox', { name: /^文件内容/ })
  const unsaved = page.getByText('未保存', { exact: true })
  const showFileButton = page.getByRole('button', { name: '显示文件', exact: true })
  assert.equal(await showFileButton.count(), 0)
  await assert.rejects(
    page.evaluate(() => window.electronAPI.showSavedFile()),
    /No saved file for this window/,
  )
  // Capture file-manager requests without opening real Explorer windows.
  const shownFiles = await desktop.evaluateHandle(({ shell }) => {
    const paths = []
    shell.showItemInFolder = (path) => {
      paths.push(path)
    }
    return paths
  })
  await page.getByRole('button', { name: '打开文本文件', exact: true }).click()
  await page.getByLabel('文件内容 · 输入.txt', { exact: true }).waitFor()
  assert.equal(await editor.inputValue(), originalText)
  assert.equal(await unsaved.count(), 0)
  const editedText = `${originalText}\n已编辑`
  await editor.fill(editedText)
  await unsaved.waitFor()
  await editor.fill(originalText)
  await unsaved.waitFor({ state: 'hidden' })
  await editor.fill(editedText)
  await page.getByRole('button', { name: '另存为', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已保存：另存为.txt' }).waitFor()
  assert.equal(await readFile(outputFile, 'utf8'), editedText)
  assert.equal(await readFile(inputFile, 'utf8'), originalText)
  assert.equal(await unsaved.count(), 0)
  await showFileButton.click()
  await page.waitForFunction(() => !window.document.querySelector('#text-file-content').disabled)
  assert.deepEqual(await shownFiles.jsonValue(), [outputFile])

  // Shortcuts use the same file operations and save the latest editor content.
  await editor.press('ControlOrMeta+o')
  await page.getByLabel('文件内容 · 输入.txt', { exact: true }).waitFor()
  assert.equal(await editor.inputValue(), originalText)
  await editor.fill('快捷键保存的最新内容')
  await editor.press('ControlOrMeta+Shift+s')
  await page.getByRole('status').filter({ hasText: '已保存：另存为.txt' }).waitFor()
  assert.equal(await readFile(outputFile, 'utf8'), '快捷键保存的最新内容')
  await editor.fill(editedText)
  await page.getByRole('button', { name: '另存为', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已保存：另存为.txt' }).waitFor()

  // Keep one dialog pending to check that repeated shortcuts cannot open another.
  const pendingDialog = await desktop.evaluateHandle(({ dialog }) => {
    const state = { calls: 0, cancel: null }
    dialog.showOpenDialog = () => {
      state.calls += 1
      return new Promise((resolve) => {
        state.cancel = () => resolve({ canceled: true, filePaths: [] })
      })
    }
    dialog.showSaveDialog = async () => {
      state.calls += 1
      return { canceled: true }
    }
    return state
  })
  await page.keyboard.press('ControlOrMeta+o')
  await page.getByRole('button', { name: '正在打开…', exact: true }).waitFor()
  await page.keyboard.press('ControlOrMeta+o')
  await page.keyboard.press('ControlOrMeta+Shift+s')
  assert.equal(await pendingDialog.evaluate((state) => state.calls), 1)
  await pendingDialog.evaluate((state) => state.cancel())
  await page.waitForFunction(() => !window.document.querySelector('#text-file-content').disabled)
  await pendingDialog.dispose()

  // Canceling either dialog must preserve the buffer and leave files untouched.
  await editor.fill('尚未保存的内容')
  await discardDialog.evaluate((state) => {
    state.response = 0
  })
  await chooseFiles(inputFile, outputFile)
  await page.getByRole('button', { name: '打开文本文件', exact: true }).click()
  await page.waitForFunction(() => !window.document.querySelector('#text-file-content').disabled)
  assert.equal(await editor.inputValue(), '尚未保存的内容')
  assert.equal(await unsaved.count(), 1)
  const confirmation = await discardDialog.evaluate((state) => state.options)
  assert.deepEqual(confirmation.buttons, ['取消', '放弃修改'])
  assert.equal(confirmation.defaultId, 0)
  assert.equal(confirmation.cancelId, 0)
  await discardDialog.evaluate((state) => {
    state.response = 1
  })
  await chooseFiles(null, null)
  await page.getByRole('button', { name: '打开文本文件', exact: true }).click()
  await page.getByRole('button', { name: '另存为', exact: true }).click()
  await page.waitForFunction(() => !window.document.querySelector('#text-file-content').disabled)
  assert.equal(await editor.inputValue(), '尚未保存的内容')
  assert.equal(await unsaved.count(), 1)
  assert.equal(await readFile(outputFile, 'utf8'), editedText)
  assert.equal(await page.getByRole('alert').count(), 0)
  await showFileButton.click()
  await page.waitForFunction(() => !window.document.querySelector('#text-file-content').disabled)
  assert.equal(await shownFiles.evaluate((paths) => paths.at(-1)), outputFile)

  // Empty text is a valid document, including when replacing an existing file.
  await chooseFiles(inputFile, outputFile)
  await editor.fill('')
  await page.getByRole('button', { name: '另存为', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已保存：另存为.txt' }).waitFor()
  assert.equal(await readFile(outputFile, 'utf8'), '')
  assert.equal(await unsaved.count(), 0)

  await editor.fill('允许替换的修改')
  await page.getByRole('button', { name: '打开文本文件', exact: true }).click()
  await page.getByLabel('文件内容 · 输入.txt', { exact: true }).waitFor()
  assert.equal(await editor.inputValue(), originalText)
  assert.equal(await unsaved.count(), 0)

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
  assert.equal(await unsaved.count(), 1)
  await showFileButton.click()
  await page.waitForFunction(() => !window.document.querySelector('#text-file-content').disabled)
  assert.equal(await shownFiles.evaluate((paths) => paths.at(-1)), outputFile)
  await assert.rejects(
    page.evaluate(() => window.electronAPI.openTextFile('invalid')),
    /Expected an unsaved changes flag/,
  )
  await assert.rejects(
    page.evaluate(() => window.electronAPI.saveTextFile(42)),
    /Expected text/,
  )
  await assert.rejects(
    page.evaluate(() => window.electronAPI.saveTextFile('文'.repeat(400000))),
    /Expected text/,
  )
  // Dropped files share validation and unsaved-change confirmation with the picker.
  await chooseFiles(null, outputFile)
  await discardDialog.evaluate((state) => {
    state.response = 0
  })
  await dropFiles(inputFile)
  assert.equal(await editor.inputValue(), '失败时保留的内容')
  assert.equal(await unsaved.count(), 1)
  await discardDialog.evaluate((state) => {
    state.response = 1
  })
  await dropFiles(inputFile)
  await page.getByLabel('文件内容 · 输入.txt', { exact: true }).waitFor()
  assert.equal(await editor.inputValue(), originalText)
  assert.equal(await unsaved.count(), 0)
  await editor.fill('拖入后编辑并保存')
  await page.getByRole('button', { name: '另存为', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已保存：另存为.txt' }).waitFor()
  assert.equal(await readFile(outputFile, 'utf8'), '拖入后编辑并保存')
  await editor.fill('失败时保留的内容')
  await dropFiles([inputFile, outputFile])
  await page.getByRole('alert').filter({ hasText: '请一次拖入一个文本文件' }).waitFor()
  assert.equal(await editor.inputValue(), '失败时保留的内容')
  for (const path of [invalidFile, largeFile]) {
    await dropFiles(path)
    await page.getByRole('alert').filter({ hasText: '无法打开文件' }).waitFor()
    assert.equal(await editor.inputValue(), '失败时保留的内容')
    assert.equal(await unsaved.count(), 1)
  }
  await assert.rejects(
    page.evaluate(() =>
      window.electronAPI.openTextFile(false, new window.File(['text'], 'fake.txt')),
    ),
    /Expected a dropped file path/,
  )
  await assert.rejects(
    page.evaluate(() => window.electronAPI.openTextFile(false, 'arbitrary-path.txt')),
  )

  // A later successful save replaces the target; a missing file must not be revealed.
  const latestFile = join(profile, '最近保存.txt')
  await chooseFiles(null, latestFile)
  await page.evaluate(() => window.electronAPI.saveTextFile('Another saved file'))
  await showFileButton.click()
  await page.waitForFunction(() => !window.document.querySelector('#text-file-content').disabled)
  assert.equal(await shownFiles.evaluate((paths) => paths.at(-1)), latestFile)
  const revealCount = await shownFiles.evaluate((paths) => paths.length)
  await rm(latestFile)
  await showFileButton.click()
  await page.getByRole('alert').filter({ hasText: '无法显示文件' }).waitFor()
  assert.equal(await shownFiles.evaluate((paths) => paths.length), revealCount)
  assert.equal(await editor.inputValue(), '失败时保留的内容')

  const rendererURL = page.url()
  await page.evaluate(() => window.history.replaceState(null, '', '?untrusted=1'))
  await assert.rejects(
    page.evaluate(() => window.electronAPI.openTextFile(false)),
    /Unexpected IPC sender/,
  )
  await assert.rejects(
    page.evaluate(() => window.electronAPI.showSavedFile()),
    /Unexpected IPC sender/,
  )
  assert.equal(await shownFiles.evaluate((paths) => paths.length), revealCount)
  await shownFiles.dispose()
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
  await assert.rejects(
    page.evaluate(() => window.electronAPI.showNotification('title', 'body')),
    /Unexpected IPC sender/,
  )
  assert.equal(await notificationSpy.evaluate((state) => state.calls), 5)
  await notificationSpy.dispose()
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

  // Native close/reload attempts must respect the renderer's unsaved content.
  await discardDialog.evaluate((state) => {
    state.response = 0
  })
  const previousPrompts = await discardDialog.evaluate((state) => state.calls)
  for (const action of ['close', 'reload']) {
    await desktop.evaluate(async ({ BrowserWindow }, action) => {
      const window = BrowserWindow.getAllWindows()[0]
      await new Promise((resolve) => {
        window.webContents.once('will-prevent-unload', () => resolve())
        if (action === 'close') window.close()
        else window.webContents.reload()
      })
    }, action)
    assert.equal(await editor.inputValue(), '失败时保留的内容')
    assert.equal(await unsaved.count(), 1)
  }
  assert.equal(await discardDialog.evaluate((state) => state.calls), previousPrompts + 2)
  await discardDialog.evaluate((state) => {
    state.response = 1
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await desktop.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      await new Promise((resolve) => {
        contents.once('did-finish-load', () => resolve())
        contents.reload()
      })
    })
    await editor.waitFor()
    assert.equal(await editor.inputValue(), '')
    assert.equal(await unsaved.count(), 0)
  }
  // Only the first reload discards changes; the clean page needs no confirmation.
  assert.equal(await discardDialog.evaluate((state) => state.calls), previousPrompts + 3)
  await discardDialog.dispose()
})
