import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { isRecord } from '@learn-electron/contracts'
import { parseChatGPTModels } from '@learn-electron/contracts/chatgpt'
import type { ChatGPTModel } from '@learn-electron/contracts/chatgpt'
import type { Tokens } from './oauth.ts'

export interface SavedProfile {
  id: string
  clientId: string
  subject?: string
  email?: string
  tokens?: Tokens
  reauth?: boolean
  modelId?: string
  models: ChatGPTModel[]
}

export interface SavedConnections {
  version: 1
  hostId: string
  activeId: string | null
  profiles: SavedProfile[]
}

function validTokens(value: unknown): value is Tokens {
  return (
    isRecord(value) &&
    typeof value.accessToken === 'string' &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === 'string') &&
    ['refreshToken', 'idToken'].every(
      (key) => value[key] === undefined || typeof value[key] === 'string',
    ) &&
    (value.earliestRefreshAt === undefined || typeof value.earliestRefreshAt === 'number')
  )
}

function decode(value: unknown): SavedConnections {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.hostId !== 'string' ||
    !/^urn:uuid:[\da-f-]{36}$/i.test(value.hostId) ||
    (value.activeId !== null && typeof value.activeId !== 'string') ||
    !Array.isArray(value.profiles)
  )
    throw new Error('ChatGPT 凭证文件格式无效')
  for (const profile of value.profiles) {
    if (
      !isRecord(profile) ||
      typeof profile.id !== 'string' ||
      typeof profile.clientId !== 'string' ||
      ['subject', 'email', 'modelId'].some(
        (key) => profile[key] !== undefined && typeof profile[key] !== 'string',
      ) ||
      (profile.reauth !== undefined && typeof profile.reauth !== 'boolean') ||
      (profile.tokens !== undefined && !validTokens(profile.tokens))
    )
      throw new Error('ChatGPT 凭证文件格式无效')
    parseChatGPTModels(profile.models)
  }
  const state = value as unknown as SavedConnections
  if (
    new Set(state.profiles.map((p) => p.id)).size !== state.profiles.length ||
    (state.activeId !== null && !state.profiles.some((p) => p.id === state.activeId))
  )
    throw new Error('ChatGPT 凭证文件格式无效')
  return state
}

/** The server's data-directory lease excludes other writers. Every replacement is atomic. */
export class ConnectionStorage {
  private readonly directory: string
  private readonly path: string

  constructor(dataDir: string) {
    this.directory = join(dataDir, 'chatgpt')
    this.path = join(this.directory, 'connections.json')
  }

  async load(): Promise<SavedConnections> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (process.platform === 'win32') {
      // Windows ignores POSIX mode bits. Set an explicit owner-only inheritable ACL
      // before creating any secret file; no path is interpolated into shell code.
      const script = `$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
[System.IO.Directory]::SetAccessControl($env:APP_CHATGPT_CREDENTIAL_DIRECTORY, $acl)`
      await promisify(execFile)(
        join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          windowsHide: true,
          timeout: 15_000,
          env: { ...process.env, APP_CHATGPT_CREDENTIAL_DIRECTORY: this.directory },
        },
      )
    } else await chmod(this.directory, 0o700)
    try {
      return decode(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw new Error('无法读取 ChatGPT 凭证文件，请检查文件和访问权限', { cause: error })
      const state: SavedConnections = {
        version: 1,
        hostId: `urn:uuid:${randomUUID()}`,
        activeId: null,
        profiles: [],
      }
      await this.save(state)
      return state
    }
  }

  async save(state: SavedConnections): Promise<void> {
    const temporary = join(this.directory, `${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw new Error('无法保存 ChatGPT 凭证，请检查磁盘和访问权限', { cause: error })
    }
  }
}
