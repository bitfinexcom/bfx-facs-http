'use strict'

const suite = require('./suite')

const assert = require('node:assert/strict')
const { format } = require('util')
const { HttpError } = require('../')

suite('http facility tests', (s) => {
  const message = 'ERR_HTTP: 500 - Internal Server Error'
  const status = 500
  const statusText = 'Internal Server Error'
  const headers = { 'content-type': 'application/json' }
  const response = { foo: 'bar' }

  const logs = []
  let originalError
  s.before(() => {
    originalError = console.error
    console.error = (...args) => {
      logs.push(format(...args))
    }
  })

  s.after(() => {
    console.error = originalError
  })

  s.check('constructor should work without optional params', () => {
    const err = new HttpError(message, status, statusText)
    assert.ok(err instanceof Error)
    assert.strictEqual(err.status, status)
    assert.strictEqual(err.statusText, statusText)
    assert.deepStrictEqual(err.headers, {})
    assert.strictEqual(err.response, null)
  })

  s.check('constructor should set optional arguments when provided', () => {
    const err = new HttpError(message, status, statusText, headers, response)
    assert.ok(err instanceof Error)
    assert.strictEqual(err.status, status)
    assert.strictEqual(err.statusText, statusText)
    assert.deepStrictEqual(err.headers, headers)
    assert.deepStrictEqual(err.response, response)
  })

  s.check('toString should print only message as default Error class', () => {
    const err = new HttpError(message, status, statusText, headers, response)
    assert.strictEqual(err.toString(), `HttpError: ${message}`)
  })

  s.check('toJSON should return object containing all http info', () => {
    const err = new HttpError(message, status, statusText, headers, response)
    assert.deepStrictEqual(err.toJSON(), {
      name: 'HttpError', message, status, statusText, headers, response
    })
  })

  s.check('error log should print all http related details', () => {
    const err = new HttpError(message, status, statusText, headers, response)
    console.error(err)
    const log = logs.at(-1)

    assert.strictEqual(log.includes(`HttpError: ${message}`), true)
    assert.strictEqual(log.includes(status), true)
    assert.strictEqual(log.includes(statusText), true)
    assert.strictEqual(log.includes(format(headers)), true)
    assert.strictEqual(log.includes(format(response)), true)
  })

  s.check('stack trace should print all http related details', () => {
    const err = new HttpError(message, status, statusText, headers, response)

    assert.strictEqual(err.stack.includes(`HttpError: ${message}`), true)
    assert.strictEqual(err.stack.includes(status), true)
    assert.strictEqual(err.stack.includes(statusText), true)
    assert.strictEqual(err.stack.includes(format(headers)), true)
    assert.strictEqual(err.stack.includes(format(response)), true)
  })

  s.check('stack trace should be rebuild when response is set later', () => {
    const err = new HttpError(message, status, statusText, headers)

    assert.strictEqual(err.stack.includes(`HttpError: ${message}`), true)
    assert.strictEqual(err.stack.includes(status), true)
    assert.strictEqual(err.stack.includes(statusText), true)
    assert.strictEqual(err.stack.includes(format(headers)), true)
    assert.strictEqual(err.stack.includes(format(response)), false)

    err.setResponse(response)
    assert.strictEqual(err.stack.includes(format(response)), true)
  })

  s.check('stack trace should not duplicate multi-line headers when response is set later', () => {
    const multiLineHeaders = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      server: 'cloudflare',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'sameorigin'
    }
    const err = new HttpError(message, status, statusText, multiLineHeaders)

    err.setResponse(response)

    const headerLineCount = err.stack.split("'cache-control': 'no-store'").length - 1
    assert.strictEqual(headerLineCount, 1)
  })
})
