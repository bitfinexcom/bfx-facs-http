'use strict'

const { test, hook } = require('brittle')

const run = (fn) => fn.length
  ? new Promise((resolve, reject) => fn((err) => err ? reject(err) : resolve()))
  : Promise.resolve().then(fn)

const runCheck = (fn, t) => fn.length === 2
  ? new Promise((resolve, reject) => fn(t, (err) => err ? reject(err) : resolve()))
  : Promise.resolve().then(() => fn(t))

const suite = (name, define, prefix = '', parents = []) => {
  const title = prefix ? `${prefix} ${name}` : name
  const hooks = {
    before: [],
    after: [],
    beforeEach: [],
    afterEach: []
  }
  const lineage = [...parents, hooks]

  const unhook = hook(`${title} setup`, async () => {
    for (const fn of hooks.before) await run(fn)
  })

  define({
    suite: (childName, childDefine) => suite(childName, childDefine, title, lineage),
    check: (caseName, fn) => test(`${title} ${caseName}`, async (t) => {
      try {
        for (const current of lineage) {
          for (const setup of current.beforeEach) await run(setup)
        }
        await runCheck(fn, t)
        t.pass()
      } finally {
        for (let i = lineage.length - 1; i >= 0; i--) {
          for (const cleanup of lineage[i].afterEach) await run(cleanup)
        }
      }
    }),
    before: (fn) => hooks.before.push(fn),
    after: (fn) => hooks.after.push(fn),
    beforeEach: (fn) => hooks.beforeEach.push(fn),
    afterEach: (fn) => hooks.afterEach.push(fn)
  })

  unhook(`${title} teardown`, async () => {
    for (const fn of hooks.after) await run(fn)
  })
}

module.exports = suite
