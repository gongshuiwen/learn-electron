import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

/** Owner-only directory and atomic replacement, under the server's data-directory lease. */
export class ProtectedFile<T> {
  private readonly path: string
  constructor(
    private readonly directory: string,
    name: string,
    private readonly decode: (value: unknown) => T,
  ) {
    this.path = join(directory, name)
  }

  async load(initial: () => T): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (process.platform === 'win32') {
      const script = `$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
[System.IO.Directory]::SetAccessControl($env:APP_CREDENTIAL_DIRECTORY, $acl)`
      await promisify(execFile)(
        join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          windowsHide: true,
          timeout: 15_000,
          env: { ...process.env, APP_CREDENTIAL_DIRECTORY: this.directory },
        },
      )
    } else await chmod(this.directory, 0o700)
    try {
      return this.decode(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw new Error('模型连接文件无法读取或版本不受支持，请检查格式和访问权限', {
          cause: error,
        })
      const state = initial()
      await this.save(state)
      return state
    }
  }

  async save(state: T): Promise<void> {
    const temporary = join(this.directory, `${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.path)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw new Error('无法保存模型连接，请检查磁盘和访问权限', { cause: error })
    }
  }
}
