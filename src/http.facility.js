'use strict'

const _ = require('lodash')
const async = require('async')
const Base = require('@bitfinex/bfx-facs-base')
const fetch = require('node-fetch')
const HttpError = require('./http.error')
const { lookup } = require('node:dns')
const { Agent: HttpsAgent } = require('node:https')
const { Agent: HttpAgent } = require('node:http')

class HttpFacility extends Base {
  constructor (caller, opts, ctx) {
    super(caller, opts, ctx)

    this.name = 'http'
    this._hasConf = false
    this.init()
  }

  _start (cb) {
    async.series([
      next => { super._start(next) },
      async () => {
        this.baseUrl = (this.opts.baseUrl || '').replace(/\/$/, '')
        this.timeout = this.opts.timeout || 0 // nodejs default timeout
        this.abortTimeout = this.opts.abortTimeout || 0
        this.debug = !!this.opts.debug
        this.qs = this.opts.qs ? new URLSearchParams(this.opts.qs).toString() : ''
        const CachableLookup = (await import('cacheable-lookup')).default
        this.cachableLookup = new CachableLookup()
      }
    ], cb)
  }

  _stop (cb) {
    async.series([
      next => { super._stop(next) },
      next => {
        this.baseUrl = ''
        next()
      }
    ], cb)
  }

  async request (path, opts = {}, cb = null) {
    try {
      if (_.isFunction(opts)) {
        cb = opts
        opts = {}
      }

      let url = path.includes('://') ? path : `${this.baseUrl}/${path.replace(/^\//, '')}`

      const reqOpts = _.pick(opts, ['body', 'headers', 'method', 'redirect', 'agent', 'compress', 'timeout', 'qs', 'signal'])

      const abortTimeout = opts.abortTimeout || this.abortTimeout
      let abortTimer = null
      if (abortTimeout && !reqOpts.signal) {
        const controller = new AbortController()
        reqOpts.signal = controller.signal
        abortTimer = setTimeout(() => controller.abort(), abortTimeout)
      }

      let urlHasQParams = url.includes('?')
      if (this.qs) {
        url += (urlHasQParams ? '&' : '?') + this.qs
        urlHasQParams = true
      }
      if (reqOpts.qs) {
        url += (urlHasQParams ? '&' : '?') + new URLSearchParams(reqOpts.qs).toString()
      }

      if (!reqOpts.method) reqOpts.method = 'get'
      if (!reqOpts.timeout) reqOpts.timeout = this.timeout
      reqOpts.redirect = !reqOpts.redirect ? 'manual' : 'follow'

      let reqEnc = 'text'
      let resEnc = 'text'
      switch (typeof opts.encoding) {
        case 'string':
          reqEnc = opts.encoding
          resEnc = opts.encoding
          break
        case 'object':
          reqEnc = opts.encoding.req || 'text'
          resEnc = opts.encoding.res || 'text'
          break
      }

      if (reqEnc === 'json') {
        reqOpts.headers = reqOpts.headers || {}
        reqOpts.headers['content-type'] = 'application/json'
        reqOpts.body = JSON.stringify(reqOpts.body)
      }

      if (opts.auth) {
        reqOpts.headers = reqOpts.headers || {}
        const username = opts.auth.username || ''
        const password = opts.auth.password || ''
        const base64 = Buffer.from(`${username}:${password}`).toString('base64')
        reqOpts.headers.authorization = `Basic ${base64}`
      }

      if (opts.dnsCaching || this.opts.dnsCaching) {
        const Agent = ((this.baseUrl ?? '').startsWith('https://') || path.startsWith('https://')) ? HttpsAgent : HttpAgent
        reqOpts.agent = new Agent({
          keepAlive: true,
          lookup: this.cachableLookup.lookup
        })
      }

      let httpErr = null
      try {
        const resp = await fetch(url, reqOpts)
        let respBody = null
        const headers = _.mapValues(resp.headers.raw(), (v) => {
          return v.length === 1 ? v[0] : v
        })

        if (!resp.ok) {
          httpErr = new HttpError(
            `ERR_HTTP: ${resp.status} - ${resp.statusText}`,
            resp.status,
            resp.statusText,
            headers
          )
        }

        if (reqOpts.method !== 'head' && reqOpts.method !== 'options') {
          try {
            switch (resEnc) {
              case 'json':
                respBody = await resp.json()
                break
              case 'text':
                respBody = await resp.text()
                break
              case 'raw':
                respBody = resp.body
                break
              default:
                respBody = await resp.buffer()
                break
            }
          } catch (err) {
            if (this.debug) console.error(new Date().toISOString(), err)
            if (!httpErr) return this._response(err, null, headers, cb)
          }
        }

        if (httpErr && respBody) httpErr.setResponse(respBody)

        return this._response(httpErr, respBody, headers, cb)
      } finally {
        if (abortTimer) clearTimeout(abortTimer)
      }
    } catch (err) {
      return this._response(err, null, {}, cb)
    }
  }

  async get (path, opts = {}, cb = null) {
    return this._methodRequest(path, 'get', opts, cb)
  }

  async post (path, opts = {}, cb = null) {
    return this._methodRequest(path, 'post', opts, cb)
  }

  async patch (path, opts = {}, cb = null) {
    return this._methodRequest(path, 'patch', opts, cb)
  }

  async put (path, opts = {}, cb = null) {
    return this._methodRequest(path, 'put', opts, cb)
  }

  async delete (path, opts = {}, cb = null) {
    return this._methodRequest(path, 'delete', opts, cb)
  }

  async options (path, opts = {}, cb = null) {
    return this._methodRequest(path, 'options', opts, cb)
  }

  async head (path, opts = {}, cb = null) {
    return this._methodRequest(path, 'head', opts, cb)
  }

  async _methodRequest (path, method, opts = {}, cb = null) {
    if (_.isFunction(opts)) {
      cb = opts
      opts = {}
    }

    return this.request(path, { ...opts, method }, cb)
  }

  _response (err, respBody, headers, cb) {
    const res = { body: respBody, headers }
    if (_.isFunction(cb)) return cb(err, res)

    if (err) return Promise.reject(err)
    return Promise.resolve(res)
  }
}

module.exports = HttpFacility
