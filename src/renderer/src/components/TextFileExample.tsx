import { useEffect, useEffectEvent, useState } from 'react'
import { FolderOpen, Save } from 'lucide-react'
import type { TextFile } from '../../../shared/ipc'
import { Button } from '@/components/ui/button'

export function TextFileExample() {
  const [file, setFile] = useState<TextFile>({ name: '未命名.txt', content: '' })
  const [savedContent, setSavedContent] = useState('')
  const [pending, setPending] = useState<'open' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const hasUnsavedChanges = file.content !== savedContent

  useEffect(() => {
    if (!hasUnsavedChanges) return
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventUnload)
    return () => window.removeEventListener('beforeunload', preventUnload)
  }, [hasUnsavedChanges])

  async function openFile(droppedFile?: File): Promise<void> {
    setPending('open')
    setError(null)
    setMessage(null)
    try {
      const result = await window.electronAPI.openTextFile(hasUnsavedChanges, droppedFile)
      if (result) {
        setFile(result)
        setSavedContent(result.content)
      }
    } catch {
      setError('无法打开文件，请检查读取权限，并选择不超过 1 MiB 的 UTF-8 文本文件。')
    } finally {
      setPending(null)
    }
  }

  async function saveFile(): Promise<void> {
    setPending('save')
    setError(null)
    setMessage(null)
    try {
      const name = await window.electronAPI.saveTextFile(file.content)
      if (name) {
        setFile((current) => ({ ...current, name }))
        setSavedContent(file.content)
        setMessage(`已保存：${name}`)
      }
    } catch {
      setError('无法保存文件，请检查写入权限，并确保内容不超过 1 MiB。')
    } finally {
      setPending(null)
    }
  }

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey === event.metaKey
    )
      return
    const key = event.key.toLowerCase()
    const open = key === 'o' && !event.shiftKey
    const save = key === 's' && event.shiftKey
    if (!open && !save) return
    event.preventDefault()
    if (event.repeat || pending !== null) return
    void (open ? openFile() : saveFile())
  })

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <section className="mt-5 rounded-2xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
      <p className="text-xs font-medium tracking-widest text-stone-400">03 / FILE</p>
      <h2 className="mt-3 text-lg font-semibold">文本文件</h2>
      <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">
        支持 1 MiB 以内的 UTF-8
        文本，可将单个文件拖入下方编辑区打开。打开文件会替换编辑区内容，修改后请另存为。
        快捷键：Ctrl/Cmd+O 打开，Ctrl/Cmd+Shift+S 另存为。
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button
          variant="outline"
          disabled={pending !== null}
          aria-keyshortcuts="Control+O Meta+O"
          onClick={() => void openFile()}
        >
          <FolderOpen aria-hidden="true" />
          {pending === 'open' ? '正在打开…' : '打开文本文件'}
        </Button>
        <Button
          disabled={pending !== null}
          aria-keyshortcuts="Control+Shift+S Meta+Shift+S"
          onClick={() => void saveFile()}
        >
          <Save aria-hidden="true" />
          {pending === 'save' ? '正在保存…' : '另存为'}
        </Button>
      </div>
      <label htmlFor="text-file-content" className="mt-4 block break-all text-sm font-medium">
        文件内容 · {file.name}
        {hasUnsavedChanges ? (
          <span className="ml-2 text-amber-700 dark:text-amber-400">未保存</span>
        ) : null}
      </label>
      <textarea
        id="text-file-content"
        value={file.content}
        disabled={pending !== null}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = pending === null ? 'copy' : 'none'
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          if (pending !== null) return
          if (event.dataTransfer.files.length !== 1) {
            setError('请一次拖入一个文本文件。')
            setMessage(null)
            return
          }
          void openFile(event.dataTransfer.files[0])
        }}
        onChange={(event) => {
          const content = event.currentTarget.value
          setFile((current) => ({ ...current, content }))
          setMessage(null)
        }}
        rows={6}
        spellCheck={false}
        className="mt-2 block w-full resize-y rounded-lg border border-stone-300 bg-transparent p-3 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:opacity-50 dark:border-stone-700"
      />
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <p role="status" className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        {message}
      </p>
    </section>
  )
}
