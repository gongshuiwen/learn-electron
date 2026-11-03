import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer failed:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-8 text-center">
          <h1 className="text-2xl font-semibold">页面暂时无法显示</h1>
          <p role="alert" className="text-stone-600 dark:text-stone-400">
            界面发生了错误，请重新加载后再试。
          </p>
          <button
            type="button"
            className="rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-600"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </main>
      )
    }

    return this.props.children
  }
}
