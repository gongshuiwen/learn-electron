import { useEffect, useState } from 'react'
import { isThemeSource } from '../../../shared/ipc'
import type { ThemeSource } from '../../../shared/ipc'

export function ThemeSelect() {
  const [source, setSource] = useState<ThemeSource>('system')
  const [pending, setPending] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.electronAPI.getTheme().then(
      (theme) => {
        if (active) {
          setSource(theme)
          setPending(false)
        }
      },
      () => {
        if (active) {
          setError('无法读取主题设置。')
          setPending(false)
        }
      },
    )
    return () => {
      active = false
    }
  }, [])

  async function changeTheme(value: string): Promise<void> {
    if (!isThemeSource(value)) return
    setPending(true)
    setError(null)
    try {
      setSource(await window.electronAPI.setTheme(value))
    } catch {
      setError('主题设置未能保存，请重试。')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="mb-6 flex flex-wrap items-center justify-end gap-3 text-sm">
      <label htmlFor="theme">主题</label>
      <select
        id="theme"
        value={source}
        disabled={pending}
        onChange={(event) => void changeTheme(event.currentTarget.value)}
        className="rounded-lg border border-stone-300 bg-white px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900"
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
      {error ? (
        <p role="alert" className="text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  )
}
