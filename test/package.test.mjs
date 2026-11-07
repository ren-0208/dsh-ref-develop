/**
 * Packaging contract: install this repository the way a bundle install would
 * (only the files listed in package.json `files` are copied) and load it from
 * the copy. If a runtime file were missing from `files`, or the manifest/patch
 * drifted apart, this test fails — long before anything reaches a profile.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

async function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of await fs.readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)))
    else out.push(rel.split(path.sep).join('/'))
  }
  return out
}

function matches(pattern, file) {
  if (pattern === file) return true
  if (pattern.endsWith('/*.md') || pattern.endsWith('/*.json')) {
    const [dir, ext] = pattern.split('/*')
    return file.startsWith(`${dir}/`) && !file.slice(dir.length + 1).includes('/') && file.endsWith(ext)
  }
  return file.startsWith(`${pattern}/`)
}

test('manifest, patch and locale are consistent', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'))
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.exports['.'], 'missing main export')
  assert.ok(pkg.exports['./client'], 'missing client export')
  assert.ok(pkg.exports['./icon'], 'missing icon export')
  assert.ok(pkg.exports['./locale/*.json'], 'missing locale export')

  const patch = await fs.readFile(path.join(repo, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, new RegExp(`name:\\s*'?"?${pkg.name.replace('/', '\\/')}'?"?`))
  assert.match(patch, /- id:\s*growth-note/)

  for (const [locale, expected] of [['zh', '记忆与成长'], ['en', 'Memory & Growth']]) {
    const dict = JSON.parse(await fs.readFile(path.join(repo, 'locale', `${locale}.json`), 'utf8'))
    assert.ok(dict.meta?.title, `${locale}: missing meta.title`)
    assert.ok(dict.meta?.description, `${locale}: missing meta.description`)
    assert.equal(dict.meta.title, expected)
  }

  const icon = await fs.readFile(path.join(repo, 'icon.svg'), 'utf8')
  assert.match(icon, /<svg/)
  assert.ok(Buffer.byteLength(icon) < 256 * 1024)
})

test('lib imports only node builtins and relative modules', async () => {
  const files = await listFiles(repo, 'lib')
  for (const file of files) {
    const source = await fs.readFile(path.join(repo, file), 'utf8')
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1]
      assert.ok(spec.startsWith('.') || spec.startsWith('node:'), `${file} imports ${spec}`)
    }
  }
})

test('installing only package.json files yields a loadable plugin', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'))
  const all = await listFiles(repo)
  const selected = all.filter((file) => pkg.files.some((pattern) => matches(pattern, file)))
  assert.ok(selected.includes('lib/index.js'))
  assert.ok(selected.includes('lib/client.js'))
  assert.ok(selected.includes('cordis.patch.yml'))
  assert.ok(selected.includes('locale/zh.json'))
  assert.ok(selected.includes('icon.svg'))

  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-pkg-'))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-pkg-home-'))
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-pkg-cwd-'))
  try {
    for (const file of selected) {
      const target = path.join(stage, file)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(path.join(repo, file), target)
    }
    await fs.copyFile(path.join(repo, 'package.json'), path.join(stage, 'package.json'))

    process.env.DSH_HOME = home
    const tools = new Map()
    const sections = []
    const ctx = {
      logger: () => ({ info() {}, warn() {} }),
      effect: (fn) => fn(),
      on: () => () => {},
      get: () => undefined,
      tools: { register: (tool) => (tools.set(tool.name, tool), () => {}) },
      systemPrompt: { getSectionOrder: () => 10, section: (definition) => (sections.push(definition), () => {}) },
      sessionQuery: { readSession: async () => ({ events: [] }) },
      workingDirectory: { defaultDirectory: cwd, ensure: async () => cwd },
    }
    const mod = await import(pathToFileURL(path.join(stage, 'lib', 'index.js')).href)
    assert.equal(mod.name, 'growth-note')
    assert.deepEqual(mod.inject, ['tools', 'systemPrompt', 'sessionQuery', 'workingDirectory'])
    mod.apply(ctx, {})
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(tools.size, 7)
    assert.equal(sections[0].name, 'GROWTH_NOTE')

    const written = await tools.get('growth_remember').execute(
      { kind: 'knowledge', title: '打包测试知识', body: '只复制 files 列出的文件也能加载。' },
      { agent: { id: 'pkg-agent' } },
    )
    assert.match(written, /已新增/)
    const memory = await fs.readFile(path.join(home, 'growth-note', 'global', 'memory.jsonl'), 'utf8')
    assert.match(memory, /打包测试知识/)
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(cwd, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})
