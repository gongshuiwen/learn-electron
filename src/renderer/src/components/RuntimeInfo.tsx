import type { AppInfo } from '../../../shared/ipc'

interface RuntimeInfoProps {
  info: AppInfo
}

export function RuntimeInfo({ info }: RuntimeInfoProps) {
  const entries = [
    ['应用', `${info.name} ${info.version}`],
    ['Electron', info.electron],
    ['Chromium', info.chrome],
    ['Node.js', info.node],
  ]

  return (
    <dl className="space-y-2 border-t border-stone-100 pt-4 text-xs">
      {entries.map(([label, value]) => (
        <div key={label} className="flex flex-wrap justify-between gap-2">
          <dt className="text-stone-500">{label}</dt>
          <dd className="font-mono text-stone-700">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
