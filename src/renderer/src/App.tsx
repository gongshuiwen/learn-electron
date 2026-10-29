import { useState } from 'react'
import { Info, Plus } from 'lucide-react'
import type { AppInfo } from '../../shared/ipc'
import { RuntimeInfo } from './components/RuntimeInfo'
import { ThemeSelect } from './components/ThemeSelect'
import { Button } from '@/components/ui/button'
import { TextFileExample } from './components/TextFileExample'

const technologies = ['Electron', 'TypeScript', 'React', 'Tailwind CSS']

export default function App() {
  const [count, setCount] = useState(0)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function readAppInfo(): Promise<void> {
    setPending(true)
    setError(null)
    setAppInfo(null)

    try {
      setAppInfo(await window.electronAPI.getAppInfo())
    } catch {
      setError('无法读取应用信息，请在 Electron 窗口中重试。')
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-8 py-12 sm:px-12">
      <ThemeSelect />
      <header className="mb-10">
        <p className="mb-4 text-sm font-semibold tracking-[0.2em] text-teal-700 dark:text-teal-400">
          LEARN / ELECTRON
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-stone-900 dark:text-stone-100 sm:text-5xl">
          从这里开始，构建桌面应用。
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-stone-600 dark:text-stone-400">
          用 React 编写界面，用 Tailwind CSS 添加样式，通过安全的预加载桥接调用桌面能力。
        </p>
        <ul aria-label="技术栈" className="mt-6 flex flex-wrap gap-2">
          {technologies.map((technology) => (
            <li
              key={technology}
              className="rounded-full border border-stone-300 dark:border-stone-700 px-3 py-1 text-xs font-medium text-stone-600 dark:text-stone-400"
            >
              {technology}
            </li>
          ))}
        </ul>
      </header>

      <div className="grid gap-5 md:grid-cols-2">
        <section className="rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6">
          <p className="text-xs font-medium tracking-widest text-stone-400">01 / REACT</p>
          <h2 className="mt-3 text-lg font-semibold">界面交互</h2>
          <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">
            点击按钮，验证 React 状态更新。
          </p>
          <Button className="mt-6" onClick={() => setCount((current) => current + 1)}>
            <Plus aria-hidden="true" />
            点击次数：{count}
          </Button>
        </section>

        <section className="rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6">
          <p className="text-xs font-medium tracking-widest text-stone-400">02 / ELECTRON IPC</p>
          <h2 className="mt-3 text-lg font-semibold">桌面进程通信</h2>
          <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">
            通过带类型的 API 从主进程读取运行环境。
          </p>
          <Button
            variant="outline"
            className="mt-6 disabled:cursor-wait"
            onClick={() => void readAppInfo()}
            disabled={pending}
          >
            <Info aria-hidden="true" />
            {pending ? '正在读取…' : '读取应用信息'}
          </Button>
          <div className="mt-4">
            {error ? (
              <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                {error}
              </p>
            ) : null}
            {appInfo ? <RuntimeInfo info={appInfo} /> : null}
          </div>
        </section>
      </div>

      <TextFileExample />

      <footer className="mt-8 text-xs leading-6 text-stone-500 dark:text-stone-400">
        编辑 <code className="text-stone-700 dark:text-stone-300">src/renderer/src/App.tsx</code>
        ，保存后即可查看更新。
      </footer>
    </main>
  )
}
