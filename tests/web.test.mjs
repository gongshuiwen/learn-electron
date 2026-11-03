import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { URL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

test('Web production build works without Electron', { timeout: 30000 }, async (t) => {
  const server = await preview({ configFile: 'vite.web.config.ts', preview: { port: 0 } })
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.httpServer.close((error) => (error ? reject(error) : resolve())),
      ),
  )
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
  t.after(() => browser.close())
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(server.resolvedUrls.local[0])
  await page.getByRole('heading', { name: '从这里开始，构建 Web 应用。' }).waitFor()
  assert.equal(await page.evaluate(() => typeof window.electronAPI), 'undefined')
  await page.getByRole('button', { name: '点击次数：0' }).click()
  await page.getByRole('button', { name: '点击次数：1' }).waitFor()
  await page.getByRole('button', { name: '读取应用信息' }).click()
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  await page.getByText(`${manifest.name} ${manifest.version}`, { exact: true }).waitFor()
  assert.equal(await page.getByText('Node.js', { exact: true }).count(), 0)

  const theme = page.getByLabel('主题', { exact: true })
  await theme.selectOption('dark')
  await page.locator('html.dark').waitFor()
  await page.reload()
  await page.locator('html.dark').waitFor()
  assert.equal(await theme.inputValue(), 'dark')
  await theme.selectOption('light')
  await page.locator('html:not(.dark)').waitFor()
  await page.emulateMedia({ colorScheme: 'dark' })
  await theme.selectOption('system')
  await page.locator('html.dark').waitFor()
  await page.emulateMedia({ colorScheme: 'light' })
  await page.locator('html:not(.dark)').waitFor()

  const editor = page.getByRole('textbox', { name: /文件内容/ })
  async function importFile(buffer) {
    const chooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '打开文本文件' }).click()
    const chooser = await chooserPromise
    await chooser.setFiles({ name: 'example.txt', mimeType: 'text/plain', buffer })
  }
  await importFile(Buffer.from('你好 Web'))
  await page.waitForFunction(() => window.document.querySelector('textarea').value === '你好 Web')
  await importFile(Buffer.from([0xff]))
  await page.getByRole('alert').filter({ hasText: '无法打开文件' }).waitFor()
  assert.equal(await editor.inputValue(), '你好 Web')
  await importFile(Buffer.alloc(1024 * 1024 + 1))
  await page.getByRole('alert').filter({ hasText: '无法打开文件' }).waitFor()
  assert.equal(await editor.inputValue(), '你好 Web')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '打开文本文件' }).click()
  await chooserPromise
  await page.locator('input[type=file]').dispatchEvent('cancel')
  await page.getByRole('button', { name: '打开文本文件' }).waitFor()
  assert.equal(await editor.inputValue(), '你好 Web')

  await editor.fill('修改后的文本')
  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByRole('button', { name: '打开文本文件' }).click()
  assert.equal(await editor.inputValue(), '修改后的文本')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载文本文件' }).click()
  const download = await downloadPromise
  assert.equal(download.suggestedFilename(), 'example.txt')
  assert.equal(await readFile(await download.path(), 'utf8'), '修改后的文本')
  await page.getByRole('status').filter({ hasText: '已发起下载' }).waitFor()
  await page.getByText('未保存', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '显示文件' }).count(), 0)
  assert.deepEqual(errors, [])
})
