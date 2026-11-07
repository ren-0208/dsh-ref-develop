import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientFile = path.join(here, '..', 'lib', 'client.js')

function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const hook = () => undefined
  return { createElement, useState: hook, useEffect: hook, useCallback: hook, useMemo: hook, useRef: hook }
}

async function loadClient() {
  const source = await fs.readFile(clientFile, 'utf8')
  const captured = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          captured.push(definition)
        },
      },
    },
    document: undefined,
    console,
    fetch() {
      throw new Error('the client module must not hit the network while loading')
    },
    setTimeout,
    clearTimeout,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: clientFile })
  assert.equal(captured.length, 1)
  const definition = captured[0]
  const exports = definition.factory((name) => {
    assert.equal(name, 'react')
    return fakeReact()
  })
  return { definition, exports }
}

test('client module registers the settings section and stays side-effect free', async () => {
  const { definition, exports } = await loadClient()
  assert.equal(definition.id, '@ren-0208/dsh-growth-note')
  assert.deepEqual([...exports.inject], ['slots'])
  assert.equal(typeof exports.apply, 'function')

  const injected = []
  let registered = null
  const ctx = {
    effect(fn) {
      return fn()
    },
    slots: {
      inject(key, callback) {
        injected.push(key)
        return callback()
      },
      register(definition, component) {
        registered = { definition, component }
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  assert.deepEqual(injected, ['settings.section'])
  assert.equal(registered.definition.name, 'settings.section')
  assert.equal(registered.definition.id, 'growth-note')
  assert.equal(registered.definition.order, 7)
  assert.equal(registered.definition.label(), '记忆与成长')
  assert.equal(typeof registered.component, 'function')
})
