import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The desktop backend remains reachable without an Internet connection.
      networkMode: 'always',
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
})

const container = document.getElementById('root')

if (!container) {
  throw new Error('Root element was not found')
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
