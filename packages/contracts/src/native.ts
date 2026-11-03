export type ThemeSource = 'system' | 'light' | 'dark'

export function isThemeSource(value: unknown): value is ThemeSource {
  return value === 'system' || value === 'light' || value === 'dark'
}

/** Native capabilities used by the shared UI; no Electron runtime types. */
export interface NativeBridge {
  readonly apiBaseUrl: string
  getTheme: () => Promise<ThemeSource>
  setTheme: (source: ThemeSource) => Promise<ThemeSource>
}
