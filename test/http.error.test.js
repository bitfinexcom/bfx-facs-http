'use strict'

const suite = require('./suite')

const chai = require('chai')
const sinon = require('sinon')
const { expect } = chai.use(require('dirty-chai'))
const { format } = require('util')
const { HttpError } = require('../')

suite('http facility tests', (s) => {
  const message = 'ERR_HTTP: 500 - Internal Server Error'
  const status = 500
  const statusText = 'Internal Server Error'
  const headers = { 'content-type': 'application/json' }
  const response = { foo: 'bar' }

  const logs = []
  const errStub = sinon.stub(console, 'error').callsFake((...args) => {
    const log = format(...args)
    logs.push(log)
  })

  s.after(() => {
    errStub.restore()
  })

  s.check('constructor should work without optional params', () => {
    const err = new HttpError(message, status, statusText)
    expect(err).to.be.instanceOf(Error)
    expect(err.status).to.be.equal(status)
    expect(err.statusText).to.be.equal(statusText)
    expect(err.headers).to.be.deep.equal({})
    expect(err.response).to.be.null()
  })

  s.check('constructor should set optional arguments when provided', () => {
    const err = new HttpError(message, status, statusText, headers, response)
    expect(err).to.be.instanceOf(Error)
    expect(err.status).to.be.equal(status)
    expect(err.statusText).to.be.equal(statusText)
    expect(err.headers).to.be.deep.equal(headers)
    expect(err.response).to.be.deep.equal(response)
  })

  s.check('toString should print only message as default Error class', () => {
    const err = new HttpError(message, status, statusText, headers, response)
    expect(err.toString()).to.be.equal(`HttpError: ${message}`)
  })

  s.check('toJSON should return object containing all http info', () => {
    const err = new HttpError(message, status, statusText, headers, response)
    expect(err.toJSON()).to.be.deep.equal({
      name: 'HttpError', message, status, statusText, headers, response
    })
  })

  s.check('error log should print all http related details', () => {
    const err = new HttpError(message, status, statusText, headers, response)
    console.error(err)
    const log = logs.at(-1)

    expect(log.includes(`HttpError: ${message}`)).to.be.true()
    expect(log.includes(status)).to.be.true()
    expect(log.includes(statusText)).to.be.true()
    expect(log.includes(format(headers))).to.be.true()
    expect(log.includes(format(response))).to.be.true()
  })

  s.check('stack trace should print all http related details', () => {
    const err = new HttpError(message, status, statusText, headers, response)

    expect(err.stack.includes(`HttpError: ${message}`)).to.be.true()
    expect(err.stack.includes(status)).to.be.true()
    expect(err.stack.includes(statusText)).to.be.true()
    expect(err.stack.includes(format(headers))).to.be.true()
    expect(err.stack.includes(format(response))).to.be.true()
  })

  s.check('stack trace should be rebuild when response is set later', () => {
    const err = new HttpError(message, status, statusText, headers)

    expect(err.stack.includes(`HttpError: ${message}`)).to.be.true()
    expect(err.stack.includes(status)).to.be.true()
    expect(err.stack.includes(statusText)).to.be.true()
    expect(err.stack.includes(format(headers))).to.be.true()
    expect(err.stack.includes(format(response))).to.be.false()

    err.setResponse(response)
    expect(err.stack.includes(format(response))).to.be.true()
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
    expect(headerLineCount).to.be.equal(1)
  })
})
