'use strict'

const suite = require('./suite')

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

  s.check('constructor should work without optional params', (t) => {
    const err = new HttpError(message, status, statusText)
    t.ok(err instanceof Error)
    t.is(err.status, status)
    t.is(err.statusText, statusText)
    t.alike(err.headers, {})
    t.is(err.response, null)
  })

  s.check('constructor should set optional arguments when provided', (t) => {
    const err = new HttpError(message, status, statusText, headers, response)
    t.ok(err instanceof Error)
    t.is(err.status, status)
    t.is(err.statusText, statusText)
    t.alike(err.headers, headers)
    t.alike(err.response, response)
  })

  s.check('toString should print only message as default Error class', (t) => {
    const err = new HttpError(message, status, statusText, headers, response)
    t.is(err.toString(), `HttpError: ${message}`)
  })

  s.check('toJSON should return object containing all http info', (t) => {
    const err = new HttpError(message, status, statusText, headers, response)
    t.alike(err.toJSON(), {
      name: 'HttpError', message, status, statusText, headers, response
    })
  })

  s.check('error log should print all http related details', (t) => {
    const err = new HttpError(message, status, statusText, headers, response)
    console.error(err)
    const log = logs.at(-1)

    t.is(log.includes(`HttpError: ${message}`), true)
    t.is(log.includes(status), true)
    t.is(log.includes(statusText), true)
    t.is(log.includes(format(headers)), true)
    t.is(log.includes(format(response)), true)
  })

  s.check('stack trace should print all http related details', (t) => {
    const err = new HttpError(message, status, statusText, headers, response)

    t.is(err.stack.includes(`HttpError: ${message}`), true)
    t.is(err.stack.includes(status), true)
    t.is(err.stack.includes(statusText), true)
    t.is(err.stack.includes(format(headers)), true)
    t.is(err.stack.includes(format(response)), true)
  })

  s.check('stack trace should be rebuild when response is set later', (t) => {
    const err = new HttpError(message, status, statusText, headers)

    t.is(err.stack.includes(`HttpError: ${message}`), true)
    t.is(err.stack.includes(status), true)
    t.is(err.stack.includes(statusText), true)
    t.is(err.stack.includes(format(headers)), true)
    t.is(err.stack.includes(format(response)), false)

    err.setResponse(response)
    t.is(err.stack.includes(format(response)), true)
  })

  s.check('stack trace should not duplicate multi-line headers when response is set later', (t) => {
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
    t.is(headerLineCount, 1)
  })
})
