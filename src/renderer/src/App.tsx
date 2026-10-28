import { useState } from 'react'
import type { AppInfo } from '../../shared/ipc'
import { RuntimeInfo } from './components/RuntimeInfo'

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
      <header className="mb-10">
        <p className="mb-4 text-sm font-semibold tracking-[0.2em] text-teal-700">
          LEARN / ELECTRON
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">
          从这里开始，构建桌面应用。
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-stone-600">
          用 React 编写界面，用 Tailwind CSS 添加样式，通过安全的预加载桥接调用桌面能力。
        </p>
        <ul aria-label="技术栈" className="mt-6 flex flex-wrap gap-2">
          {technologies.map((technology) => (
            <li
              key={technology}
              className="rounded-full border border-stone-300 px-3 py-1 text-xs font-medium text-stone-600"
            >
              {technology}
            </li>
          ))}
        </ul>
      </header>

      <div className="grid gap-5 md:grid-cols-2">
        <section className="rounded-2xl border border-stone-200 bg-white p-6">
          <p className="text-xs font-medium tracking-widest text-stone-400">01 / REACT</p>
          <h2 className="mt-3 text-lg font-semibold">界面交互</h2>
          <p className="mt-2 text-sm leading-6 text-stone-500">点击按钮，验证 React 状态更新。</p>
          <button
            type="button"
            className="mt-6 rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-600"
            onClick={() => setCount((current) => current + 1)}
          >
            点击次数：{count}
          </button>
        </section>

        <section className="rounded-2xl border border-stone-200 bg-white p-6">
          <p className="text-xs font-medium tracking-widest text-stone-400">02 / ELECTRON IPC</p>
          <h2 className="mt-3 text-lg font-semibold">桌面进程通信</h2>
          <p className="mt-2 text-sm leading-6 text-stone-500">
            通过带类型的 API 从主进程读取运行环境。
          </p>
          <button
            type="button"
            className="mt-6 rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-600 disabled:cursor-wait disabled:opacity-50"
            onClick={() => void readAppInfo()}
            disabled={pending}
          >
            {pending ? '正在读取…' : '读取应用信息'}
          </button>
          <div role="status" className="mt-4">
            {error ? <p className="text-sm text-red-700">{error}</p> : null}
            {appInfo ? <RuntimeInfo info={appInfo} /> : null}
          </div>
        </section>
      </div>

      <footer className="mt-8 text-xs leading-6 text-stone-500">
        编辑 <code className="text-stone-700">src/renderer/src/App.tsx</code>，保存后即可查看更新。
      </footer>
    </main>
  )
}
