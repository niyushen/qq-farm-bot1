import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createPinia, disposePinia } = require('pinia')
const ts = require('typescript')

test('邮箱时刻可读取和保存，午夜与旧配置默认值正确，账号切换不串值', async (t) => {
  const pinia = createPinia()
  t.after(() => disposePinia(pinia))
  const accounts = { a: { emailClaimHour: 0 }, b: { emailClaimHour: 17 }, legacy: {} }
  const posts = []
  let release
  const api = {
    get: async (_url, options) => ({ data: { ok: true, data: accounts[options.headers['x-account-id']] } }),
    post: async (url, body, options) => {
      posts.push({ url, body, accountId: options.headers['x-account-id'] })
      if (release === null)
        await new Promise(resolve => release = resolve)
      return { data: { ok: true, data: body } }
    },
  }
  const source = readFileSync(new URL('../src/stores/setting.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
  const module = { exports: {} }
  // 支持 '@/' 别名：转译 src 下的 TS 模块后加载（原生 require 无法解析别名）。
  // 被加载模块内部的相对路径 require 必须以该模块自身位置为基准，
  // 否则 '../../../core/src/...' 这类跨目录引用会解析到错误位置。
  const aliasCache = new Map()
  const loadAliased = (id, baseUrl = import.meta.url) => {
    // 裸模块名走 Node 解析；相对路径以被加载模块自身位置为基准
    if (!id.startsWith('@/') && !id.startsWith('.'))
      return require(id)
    if (!id.startsWith('@/'))
      return require(fileURLToPath(new URL(id, baseUrl)))
    if (aliasCache.has(id))
      return aliasCache.get(id)
    const rel = id.slice(2).replace(/\.ts$/, '')
    const file = new URL(`../src/${rel}.ts`, import.meta.url)
    const code = readFileSync(file, 'utf8')
    const compiled = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } })
    const mod = { exports: {} }
    new Function('require', 'module', 'exports', compiled.outputText)(
      (dep) => loadAliased(dep, file),
      mod,
      mod.exports,
    )
    aliasCache.set(id, mod.exports)
    return mod.exports
  }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', outputText)(id => {
    if (id === '@/api')
      return { __esModule: true, default: api, getApiErrorMessage: value => value.error }
    return loadAliased(id)
  }, module, module.exports)
  const store = module.exports.useSettingStore(pinia)

  await store.fetchSettings('a')
  assert.equal(store.settings.emailClaimHour, 0)
  assert.equal((await store.saveSettings('a', { emailClaimHour: 23 })).ok, true)
  assert.equal(store.settings.emailClaimHour, 23)
  assert.deepEqual(posts[0], { url: '/api/settings/save', body: { emailClaimHour: 23 }, accountId: 'a' })

  release = null
  const pending = store.saveSettings('a', { emailClaimHour: 1 })
  await store.fetchSettings('b')
  assert.equal(store.settings.emailClaimHour, 17)
  release()
  await pending
  assert.equal(store.settings.emailClaimHour, 17, '旧账号保存响应不覆盖新账号')
  await store.fetchSettings('legacy')
  assert.equal(store.settings.emailClaimHour, 10)
})
