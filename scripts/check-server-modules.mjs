import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const dependencies = new Map([
  ['entry', ['http', 'chat', 'models', 'chatgpt', 'shared']],
  ['http', ['chat', 'models', 'chatgpt', 'shared']],
  ['chat', ['models', 'shared']],
  ['chatgpt', ['models', 'shared']],
  ['models', ['shared']],
  ['shared', []],
])
const entryFiles = new Set(['cli.ts', 'desktop-child.ts', 'lifecycle.ts', 'server.ts'])

function portable(path) {
  return path.split(sep).join('/')
}

function contains(directory, file) {
  const path = relative(directory, file)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function cycles(graph) {
  const visited = new Set()
  const active = new Map()
  const stack = []
  const found = []
  function visit(node) {
    active.set(node, stack.length)
    stack.push(node)
    for (const target of graph.get(node) ?? []) {
      if (active.has(target)) found.push([...stack.slice(active.get(target)), target])
      else if (!visited.has(target)) visit(target)
    }
    stack.pop()
    active.delete(node)
    visited.add(node)
  }
  for (const node of graph.keys()) if (!visited.has(node)) visit(node)
  return found
}

/** Check source dependencies, including type imports, re-exports and literal dynamic imports. */
export function checkServerModules(root) {
  root = realpathSync(root)
  const sourceDirectory = realpathSync(resolve(root, 'apps/server/src'))
  const configPath = resolve(root, 'apps/server/tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const { options, errors } = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
  )
  if (errors.length)
    throw new Error(
      errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'),
    )
  const cache = ts.createModuleResolutionCache(
    root,
    (file) => (ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase()),
    options,
  )
  const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
  const files = [
    ...new Set(ts.sys.readDirectory(sourceDirectory, extensions).map((file) => realpathSync(file))),
  ].sort()
  const fileGraph = new Map(files.map((file) => [file, new Set()]))
  const moduleGraph = new Map([...dependencies.keys()].map((module) => [module, new Set()]))
  const violations = []
  const display = (file) => portable(relative(root, file))
  const moduleOf = (file) => {
    const directory = portable(relative(sourceDirectory, dirname(file)))
    return directory || 'entry'
  }

  for (const file of files) {
    const module = moduleOf(file)
    if (!dependencies.has(module)) violations.push(`${display(file)}: 未登记的后端模块 ${module}`)
    if (module === 'entry' && !entryFiles.has(relative(sourceDirectory, file)))
      violations.push(`${display(file)}: 根目录只保留启动和装配入口`)
    if (
      module !== 'entry' &&
      dependencies.has(module) &&
      !fileGraph.has(resolve(dirname(file), 'index.ts'))
    )
      violations.push(`${display(file)}: 模块 ${module} 缺少公开入口 index.ts`)

    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    function report(node, message) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      violations.push(`${display(file)}:${line}: ${message}`)
    }
    function dependency(node, specifier) {
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys, cache).resolvedModule
      if (!resolved) {
        const mapped = Object.keys(options.paths ?? {}).some((pattern) => {
          const [prefix, suffix] = pattern.split('*')
          return suffix === undefined
            ? specifier === pattern
            : specifier.startsWith(prefix) && specifier.endsWith(suffix)
        })
        if (
          specifier.startsWith('.') ||
          specifier.startsWith('#') ||
          specifier === '@learn-electron/server' ||
          specifier.startsWith('@learn-electron/server/') ||
          isAbsolute(specifier) ||
          mapped
        )
          report(node, `无法解析本地依赖 ${specifier}`)
        return
      }
      const target = realpathSync(resolved.resolvedFileName)
      if (!contains(sourceDirectory, target)) {
        const projectFile =
          contains(root, target) && !display(target).split('/').includes('node_modules')
        if (
          specifier.startsWith('.') ||
          isAbsolute(specifier) ||
          (projectFile && !specifier.startsWith('@learn-electron/')) ||
          (projectFile && /(^|\/)test\//.test(display(target)))
        )
          report(node, `后端源码不能直接依赖源码目录外的文件 ${specifier}`)
        return
      }
      fileGraph.get(file).add(target)
      const targetModule = moduleOf(target)
      if (module === targetModule) return
      moduleGraph.get(module)?.add(targetModule)
      if (!dependencies.get(module)?.includes(targetModule))
        report(node, `不允许的模块依赖 ${module} -> ${targetModule} (${specifier})`)
      if (targetModule !== 'entry' && target !== resolve(sourceDirectory, targetModule, 'index.ts'))
        report(node, `跨模块依赖必须通过 ${targetModule}/index.ts (${specifier})`)
    }
    function visit(node) {
      let specifier
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        specifier = node.moduleSpecifier
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        specifier = node.argument.literal
      else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      )
        specifier = node.moduleReference.expression
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        specifier = node.arguments[0]
        if (!specifier || !ts.isStringLiteralLike(specifier))
          report(node, '动态依赖必须使用可静态检查的字符串')
      }
      if (specifier && ts.isStringLiteralLike(specifier)) dependency(node, specifier.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  for (const cycle of cycles(moduleGraph)) violations.push(`模块循环依赖: ${cycle.join(' -> ')}`)
  for (const cycle of cycles(fileGraph))
    violations.push(`文件循环依赖: ${cycle.map(display).join(' -> ')}`)
  return violations
}

if (import.meta.main) {
  const violations = checkServerModules(fileURLToPath(new URL('../', import.meta.url)))
  if (violations.length) {
    console.error(violations.join('\n'))
    process.exitCode = 1
  } else console.log('后端模块依赖检查通过')
}
