'use strict'

const suite = require('./suite')

const assert = require('node:assert/strict')
const stream = require('stream')
const fs = require('fs')
const http = require('http')
const HttpFacility = require('../')
const { HttpError } = HttpFacility
const { format } = require('util')
const { join } = require('path')
const CacheableLookup = require('cacheable-lookup')

const rejectsWith = (promise, expected) => assert.rejects(promise, (err) => {
  if (typeof expected === 'string') assert.ok(err.message.includes(expected), err.message)
  else assert.match(err.message, expected)
  return true
})

const routes = new Map()
const route = (method, path, handler) => routes.set(`${method} ${path}`, handler)

const queryObject = (params) => {
  const query = new Map()
  for (const [key, value] of params) {
    if (!query.has(key)) query.set(key, value)
    else if (Array.isArray(query.get(key))) query.get(key).push(value)
    else query.set(key, [query.get(key), value])
  }
  return Object.fromEntries(query)
}

const sendText = (res, body, status = 200) => {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(body || '')
}

const sendJson = (res, body, status = 200) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

const serve = async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const method = req.method === 'HEAD' ? 'GET' : req.method
  const handler = routes.get(`${method} ${url.pathname}`)

  if (req.method === 'OPTIONS') {
    if (routes.has(`GET ${url.pathname}`)) res.setHeader('allow', 'GET,HEAD')
    res.end()
    return
  }

  if (!handler) {
    res.statusCode = 404
    res.end()
    return
  }

  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString()
  const contentType = req.headers['content-type'] || ''
  req.query = queryObject(url.searchParams)
  req.body = contentType.startsWith('application/json') && body
    ? JSON.parse(body)
    : contentType.startsWith('application/x-www-form-urlencoded')
      ? queryObject(new URLSearchParams(body))
      : {}
  handler(req, res)
}

suite('http facility tests', (s) => {
  let srv = null
  let fac = new HttpFacility({}, { baseUrl: 'http://127.0.0.1:7070' }, { env: 'test' })
  let sockets

  s.before((done) => {
    sockets = new Set()
    fac.start((err) => {
      if (err) return done(err)

      srv = http.createServer((req, res) => {
        serve(req, res).catch((err) => {
          res.statusCode = 500
          res.end(err.message)
        })
      })
      srv.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      srv.listen(7070, done)
    })
  })

  s.after((done) => {
    fac.stop((err) => {
      if (err) return done(err)
      for (const socket of sockets) socket.destroy()
      srv.close(done)
    })
  })

  s.afterEach(() => {
    fac.baseUrl = 'http://127.0.0.1:7070'
  })

  s.suite('constructor tests', (s) => {
    s.check('should set base url to empty string when missing', (done) => {
      const fac = new HttpFacility({}, {}, { env: 'test' })

      fac.start(() => {
        assert.strictEqual(fac.baseUrl, '')
        done()
      })
    })
  })

  s.suite('_response tests', (s) => {
    s.check('should perform call callback when provided', (done) => {
      fac._response(null, 123, {}, (err, res) => {
        assert.strictEqual(err, null)
        assert.deepStrictEqual(res, { body: 123, headers: {} })
        done()
      })
    })

    s.check('should reject promise when no callback is provided and error is present', async () => {
      await rejectsWith(fac._response(new Error('FOO'), 123, {}), 'FOO')
    })

    s.check('should resolve promise when no callback is provided and error is falsy', async () => {
      const res = await fac._response(null, 123, {})
      assert.deepStrictEqual(res, { body: 123, headers: {} })
    })
  })

  s.suite('request tests', (s) => {
    let body = null

    s.afterEach(() => {
      body = null
    })

    s.check('should throw error on invalid url', async () => {
      fac.baseUrl = ''

      await rejectsWith(fac.request('foo/bar'), 'Only absolute URLs are supported')
    })

    s.check('should throw error on invalid request params', async () => {
      await rejectsWith(fac.request('http://127.0.0.1:7070', { method: 'cut' }), 'ERR_HTTP: 400 - Bad Request')
    })

    s.check('should parse http errors as expected', async () => {
      route('GET', '/foo/bar/1', (req, res) => {
        sendJson(res, { auth: false }, 500)
      })

      let httpErr = null
      try {
        await fac.request('/foo/bar/1')
      } catch (err) {
        httpErr = err
      }

      assert.ok(httpErr instanceof HttpError)
      assert.strictEqual(httpErr.message, 'ERR_HTTP: 500 - Internal Server Error')
      assert.strictEqual(httpErr.status, 500)
      assert.strictEqual(httpErr.statusText, 'Internal Server Error')
      assert.strictEqual(httpErr.response, '{"auth":false}')
      assert.ok(httpErr.headers !== null && typeof httpErr.headers === 'object')
    })

    s.check('should support paths when base url is set', async () => {
      route('GET', '/foo/bar/2', (req, res) => {
        sendText(res, 'test')
      })

      const { body: resp } = await fac.request('foo/bar/2', { method: 'get' })
      assert.strictEqual(resp, 'test')
    })

    s.check('should ignore leading slashes from url while concatenating url', async () => {
      route('GET', '/foo/bar/3', (req, res) => {
        sendText(res, 'test')
      })

      const { body: resp } = await fac.request('/foo/bar/3', { method: 'get' })
      assert.strictEqual(resp, 'test')
    })

    s.check('should ignore base url when path is full url', async () => {
      const { body: resp } = await fac.request('https://www.google.com', { method: 'get' })
      assert.ok(resp.includes('<html'))
    })

    s.check('should support body encodings', async () => {
      route('POST', '/foo/bar/4', (req, res) => {
        body = req.body
        sendJson(res, { success: true })
      })

      const reqOpts = {
        method: 'post',
        body: { data: 'test' },
        encoding: 'json'
      }
      const { body: resp } = await fac.request('/foo/bar/4', reqOpts)

      assert.deepStrictEqual(resp, { success: true })
      assert.deepStrictEqual(body, { data: 'test' })
    })

    s.check('should support different encodings for request and response', async () => {
      route('POST', '/foo/bar/5', (req, res) => {
        body = req.body
        sendText(res, 'test')
      })

      const reqOpts = {
        method: 'post',
        body: { data: 'test' },
        encoding: {
          req: 'json',
          res: 'text'
        }
      }
      const { body: resp } = await fac.request('/foo/bar/5', reqOpts)

      assert.deepStrictEqual(resp, 'test')
      assert.deepStrictEqual(body, { data: 'test' })
    })

    s.check('should return text encoding by default on response', async () => {
      route('POST', '/foo/bar/6', (req, res) => {
        body = req.body
        sendText(res, '<test />')
      })

      const reqOpts = {
        method: 'post',
        body: { data: 'test' },
        encoding: {
          req: 'json'
        }
      }
      const { body: resp } = await fac.request('/foo/bar/6', reqOpts)

      assert.deepStrictEqual(resp, '<test />')
      assert.deepStrictEqual(body, { data: 'test' })
    })

    s.check('should return text encoding by default on request body', async () => {
      const reqOpts = {
        method: 'post',
        body: JSON.stringify({ data: 'test' }),
        headers: { 'content-type': 'application/json' },
        encoding: {
          res: 'json'
        }
      }
      const { body: resp } = await fac.request('/foo/bar/4', reqOpts)

      assert.deepStrictEqual(resp, { success: true })
      assert.deepStrictEqual(body, { data: 'test' })
    })

    s.check('should use buffer encoding on response when response type is not supported', async () => {
      route('POST', '/foo/bar/7', (req, res) => {
        body = req.body
        sendText(res, '<test />')
      })

      const reqOpts = {
        method: 'post',
        body: { data: 'test' },
        encoding: {
          req: 'json',
          res: 'xml'
        }
      }
      const { body: resp } = await fac.request('/foo/bar/7', reqOpts)

      assert.ok(resp instanceof Buffer)
      assert.deepStrictEqual(resp.toString('utf-8'), '<test />')
      assert.deepStrictEqual(body, { data: 'test' })
    })

    s.check('should support callbacks', (done) => {
      fac.request('/foo/bar/3', { method: 'get' }, (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'test')
        done()
      })
    })

    s.check('should handle errors in callbacks', (done) => {
      fac.request('/foo/bar/1', { method: 'get' }, (err) => {
        assert.ok(err instanceof HttpError)
        assert.strictEqual(err.message, 'ERR_HTTP: 500 - Internal Server Error')
        assert.strictEqual(err.status, 500)
        assert.strictEqual(err.statusText, 'Internal Server Error')
        assert.strictEqual(err.response, '{"auth":false}')
        assert.ok(err.headers !== null && typeof err.headers === 'object')
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.request('/foo/bar/3', (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'test')
        done()
      })
    })

    s.check('should support headers', async () => {
      const reqOpts = {
        method: 'post',
        body: JSON.stringify({ data: 'test' }),
        headers: { 'content-type': 'application/json' }
      }
      const { body: resp } = await fac.request('/foo/bar/4', reqOpts)

      assert.deepStrictEqual(resp, '{"success":true}')
      assert.deepStrictEqual(body, { data: 'test' })
    })

    s.check('should support redirect', async () => {
      const { body: resp } = await fac.request('http://google.com', { method: 'get', redirect: true })
      assert.ok(resp.includes('<html'))

      await rejectsWith(fac.request('http://google.com', { method: 'get', redirect: false }), 'ERR_HTTP: 301 - Moved Permanently')
    })

    s.check('should support user agents', async () => {
      const agent = new http.Agent({ keepAlive: false })
      const { body: resp } = await fac.request('/foo/bar/3', { method: 'get', agent })
      assert.strictEqual(resp, 'test')
    })

    s.check('should support timeout', async () => {
      route('GET', '/foo/bar/timeout', (req, res) => {
        setTimeout(() => sendText(res, 'test'), 100)
      })

      await rejectsWith(fac.request('/foo/bar/timeout', { method: 'get', timeout: 10 }), 'network timeout at: http://127.0.0.1:7070/foo/bar/timeout')
    })

    s.check('should throw error when encoding is wrong', async () => {
      await rejectsWith(fac.request('/foo/bar/3', { method: 'get', encoding: 'json' }), 'invalid json response body')
    })

    s.check('should support debugging', async () => {
      let log = null
      const originalError = console.error
      console.error = (...params) => {
        log = format(...params)
      }
      fac.debug = true

      try {
        route('GET', '/foo/bar/8', (req, res) => {
          sendText(res, 'test', 500)
        })

        await rejectsWith(fac.request('/foo/bar/8', { method: 'get', encoding: 'json' }), 'ERR_HTTP: 500 - Internal Server Error')
        assert.ok(log.includes('invalid json response body'))
      } finally {
        console.error = originalError
        fac.debug = false
      }
    })

    s.check('should support head method', async () => {
      const { headers } = await fac.request('https://api-pub.bitfinex.com/v2/conf/pub:list:currency', { method: 'head' })
      assert.ok(headers['content-type'].includes('application/json'))
    })

    s.check('should support options method', async () => {
      const { headers } = await fac.request('https://api-pub.bitfinex.com/v2/conf/pub:list:currency', { method: 'options' })
      assert.ok(headers.allow.includes('GET'))
    })

    s.check('should support streams', async () => {
      const readfile = join(__dirname, 'bfx.png')
      const writefile = join(__dirname, 'out.png')

      route('GET', '/file', (req, res) => {
        res.setHeader('content-disposition', 'attachment; filename=bfx.png')
        res.setHeader('content-type', 'image/png')

        const stream = fs.createReadStream(readfile)
        stream.pipe(res)
      })

      if (fs.existsSync(writefile)) fs.unlinkSync(writefile)

      const { body: resp } = await fac.request('/file', { encoding: { res: 'raw' } })
      await new Promise((resolve, reject) => {
        stream.pipeline(resp, fs.createWriteStream(writefile), (err) => err ? reject(err) : resolve())
      })

      assert.strictEqual(fs.existsSync(writefile), true)
    })

    s.check('should support qs params', async () => {
      route('GET', '/foo/bar/9', (req, res) => {
        sendJson(res, req.query)
      })

      let resp = await fac.request('/foo/bar/9', { method: 'get', encoding: 'json', qs: { a: 1, b: 'c' } })
      assert.deepStrictEqual(resp.body, { a: '1', b: 'c' })

      resp = await fac.request('/foo/bar/9', { method: 'get', encoding: 'json', qs: [['a', 1], ['b', 'c']] })
      assert.deepStrictEqual(resp.body, { a: '1', b: 'c' })

      resp = await fac.request('/foo/bar/9', { method: 'get', encoding: 'json', qs: 'a=1&b=c' })
      assert.deepStrictEqual(resp.body, { a: '1', b: 'c' })

      resp = await fac.request('/foo/bar/9?', { method: 'get', encoding: 'json', qs: 'a=1&b=c' })
      assert.deepStrictEqual(resp.body, { a: '1', b: 'c' })

      resp = await fac.request('/foo/bar/9', { method: 'get', encoding: 'json', qs: 123 })
      assert.deepStrictEqual(resp.body, { 123: '' })

      fac = new HttpFacility({}, { baseUrl: 'http://127.0.0.1:7070', qs: { a: 2, d: 'e' } }, { env: 'test' })
      await new Promise((resolve, reject) => fac.start((err) => err ? reject(err) : resolve()))
      resp = await fac.request('/foo/bar/9?', { method: 'get', encoding: 'json', qs: 'a=1&b=c' })
      assert.deepStrictEqual(resp.body, { a: ['2', '1'], b: 'c', d: 'e' })
    })

    s.check('should support basic authorization', async () => {
      route('GET', '/foo/bar/basic-auth', (req, res) => {
        sendText(res, req.headers.authorization)
      })

      const resp = await fac.request('/foo/bar/basic-auth', {
        method: 'get',
        auth: {
          username: 'user',
          password: 'pass'
        }
      })
      assert.strictEqual(resp.body, `Basic ${Buffer.from('user:pass').toString('base64')}`)
    })

    s.check('should not send basic authorization', async () => {
      route('GET', '/foo/bar/no-basic-auth', (req, res) => {
        sendText(res, req.headers.authorization)
      })

      const resp = await fac.request('/foo/bar/no-basic-auth', { method: 'get' })
      assert.strictEqual(resp.body, '')
    })

    s.check('should support abort signals', async () => {
      route('GET', '/foo/bar/signal', () => { })

      const abortController = new AbortController()
      setTimeout(() => {
        abortController.abort()
      }, 1000)

      await rejectsWith(fac.request('/foo/bar/signal', { method: 'get', timeout: 30000, signal: abortController.signal }), /aborted/)
    })

    s.suite('DNS caching', (s) => {
      s.beforeEach(() => {
        fac.cacheableLookup._cache.clear()
        fac.opts.dnsCaching = false
      })

      s.check('should not perform dns caching by default', async () => {
        await fac.request('https://example.com', { method: 'get', timeout: 1000 })

        assert.deepStrictEqual(fac.cacheableLookup._cache.get('example.com'), undefined)
      })

      s.check('should support dns caching for https requests', async () => {
        await fac.request('https://example.com', { method: 'get', timeout: 1000, dnsCaching: true })

        const expectedAddress = await lookupDomain('example.com')
        assert.strictEqual(fac.cacheableLookup._cache.get('example.com').some(e => e.address === expectedAddress), true)
      })

      s.check('should support dns caching for http requests', async () => {
        await fac.request('http://example.com', { method: 'get', timeout: 1000, dnsCaching: true })

        const expectedAddress = await lookupDomain('example.com')
        assert.strictEqual(fac.cacheableLookup._cache.get('example.com').some(e => e.address === expectedAddress), true)
      })

      s.check('can be activated by default through fac opts', async () => {
        fac.opts.dnsCaching = true

        await fac.request('https://example.com', { method: 'get', timeout: 1000 })

        const expectedAddress = await lookupDomain('example.com')
        assert.strictEqual(fac.cacheableLookup._cache.get('example.com').some(e => e.address === expectedAddress), true)
      })

      const lookupDomain = async (domain) => {
        const entry = await (new CacheableLookup()).lookupAsync(domain)
        return entry.address
      }
    })
  })

  s.suite('abortTimeout tests', (s) => {
    let abortFac = null

    s.before((done) => {
      route('GET', '/foo/bar/slow', (req, res) => {
        const delay = parseInt(req.query.delay) || 3000
        setTimeout(() => sendText(res, 'slow response'), delay)
      })

      abortFac = new HttpFacility({}, { baseUrl: 'http://127.0.0.1:7070', abortTimeout: 500 }, { env: 'test' })
      abortFac.start(done)
    })

    s.after((done) => {
      abortFac.stop(done)
    })

    s.check('should default abortTimeout to 0 when not configured', () => {
      assert.strictEqual(fac.abortTimeout, 0)
    })

    s.check('should set abortTimeout from opts', () => {
      assert.strictEqual(abortFac.abortTimeout, 500)
    })

    s.check('should abort slow requests with facility-level abortTimeout', async () => {
      await rejectsWith(abortFac.request('/foo/bar/slow?delay=3000', { timeout: 30000 }), /aborted/)
    })

    s.check('should succeed when request completes before abortTimeout', async () => {
      const { body: resp } = await abortFac.request('/foo/bar/slow?delay=50', { timeout: 30000 })
      assert.strictEqual(resp, 'slow response')
    })

    s.check('should allow per-request abortTimeout to override facility-level', async () => {
      const { body: resp } = await abortFac.request('/foo/bar/slow?delay=200', { abortTimeout: 2000, timeout: 30000 })
      assert.strictEqual(resp, 'slow response')
    })

    s.check('should abort with per-request abortTimeout on fac without default', async () => {
      await rejectsWith(fac.request('/foo/bar/slow?delay=3000', { abortTimeout: 200, timeout: 30000 }), /aborted/)
    })

    s.check('should not create auto-controller when caller provides signal', async () => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 100)

      await rejectsWith(abortFac.request('/foo/bar/slow?delay=3000', { signal: controller.signal, abortTimeout: 30000, timeout: 30000 }), /aborted/)
    })

    s.check('should work with callback pattern', async () => {
      const result = await new Promise((resolve) => {
        abortFac.request('/foo/bar/slow?delay=3000', { timeout: 30000 }, (err) => {
          resolve(err)
        })
      })
      assert.notStrictEqual(result, null)
      assert.strictEqual(result.name, 'AbortError')
    })

    s.check('should work through convenience methods', async () => {
      await rejectsWith(abortFac.get('/foo/bar/slow?delay=3000', { timeout: 30000 }), /aborted/)
    })
  })

  s.suite('_methodRequest tests', (s) => {
    s.before(() => {
      route('GET', '/method_request_test', (req, res) => {
        sendText(res, 'foo')
      })
    })

    s.check('should perform requests as expected', async () => {
      const { body: resp } = await fac._methodRequest('/method_request_test', 'get', { method: 'post' })
      assert.strictEqual(resp, 'foo')
    })

    s.check('should support callbacks', (done) => {
      fac._methodRequest('/method_request_test', 'get', { method: 'post' }, (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'foo')
        done()
      })
    })

    s.check('should support callback as 3nd arg', (done) => {
      fac._methodRequest('/method_request_test', 'get', (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'foo')
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { body: resp } = await fac._methodRequest('/method_request_test', 'get')
      assert.strictEqual(resp, 'foo')
    })
  })

  s.suite('get tests', (s) => {
    s.before(() => {
      route('GET', '/get_test', (req, res) => {
        sendText(res, 'test')
      })
    })

    s.check('should perform requests as expected', async () => {
      const { body: resp } = await fac.get('/get_test', { method: 'post' })
      assert.strictEqual(resp, 'test')
    })

    s.check('should support callbacks', (done) => {
      fac.get('/get_test', { method: 'post' }, (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'test')
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.get('/get_test', (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'test')
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { body: resp } = await fac.get('/get_test')
      assert.strictEqual(resp, 'test')
    })
  })

  s.suite('post tests', (s) => {
    let body = null
    const reqOpts = {
      method: 'get',
      body: 'foo=bar',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }

    s.before(() => {
      route('POST', '/post_test', (req, res) => {
        body = req.body
        sendText(res, 'bar')
      })
    })

    s.afterEach(() => {
      body = null
    })

    s.check('should perform requests as expected', async () => {
      const { body: resp } = await fac.post('/post_test', reqOpts)
      assert.strictEqual(resp, 'bar')
      assert.deepStrictEqual(body, { foo: 'bar' })
    })

    s.check('should support callbacks', (done) => {
      fac.post('/post_test', reqOpts, (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'bar')
        assert.deepStrictEqual(body, { foo: 'bar' })
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.post('/post_test', (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'bar')
        assert.deepStrictEqual(body, {})
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { body: resp } = await fac.post('/post_test')
      assert.strictEqual(resp, 'bar')
      assert.deepStrictEqual(body, {})
    })
  })

  s.suite('put tests', (s) => {
    let body = null
    const reqOpts = {
      method: 'get',
      body: 'foo=bar',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }

    s.before(() => {
      route('PUT', '/put_test', (req, res) => {
        body = req.body
        sendText(res, 'bar')
      })
    })

    s.afterEach(() => {
      body = null
    })

    s.check('should perform requests as expected', async () => {
      const { body: resp } = await fac.put('/put_test', reqOpts)
      assert.strictEqual(resp, 'bar')
      assert.deepStrictEqual(body, { foo: 'bar' })
    })

    s.check('should support callbacks', (done) => {
      fac.put('/put_test', reqOpts, (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'bar')
        assert.deepStrictEqual(body, { foo: 'bar' })
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.put('/put_test', (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'bar')
        assert.deepStrictEqual(body, {})
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { body: resp } = await fac.put('/put_test')
      assert.strictEqual(resp, 'bar')
      assert.deepStrictEqual(body, {})
    })
  })

  s.suite('patch tests', (s) => {
    let body = null
    const reqOpts = {
      method: 'get',
      body: 'foo=bar',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }

    s.before(() => {
      route('PATCH', '/patch_test', (req, res) => {
        body = req.body
        sendText(res, 'bar')
      })
    })

    s.afterEach(() => {
      body = null
    })

    s.check('should perform requests as expected', async () => {
      const { body: resp } = await fac.patch('/patch_test', reqOpts)
      assert.strictEqual(resp, 'bar')
      assert.deepStrictEqual(body, { foo: 'bar' })
    })

    s.check('should support callbacks', (done) => {
      fac.patch('/patch_test', reqOpts, (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'bar')
        assert.deepStrictEqual(body, { foo: 'bar' })
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.patch('/patch_test', (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'bar')
        assert.deepStrictEqual(body, {})
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { body: resp } = await fac.patch('/patch_test')
      assert.strictEqual(resp, 'bar')
      assert.deepStrictEqual(body, {})
    })
  })

  s.suite('delete tests', (s) => {
    let body = null
    const reqOpts = {
      method: 'get',
      body: 'foo=bar',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }

    s.before(() => {
      route('DELETE', '/delete_test', (req, res) => {
        body = req.body
        sendText(res, 'bar')
      })
    })

    s.afterEach(() => {
      body = null
    })

    s.check('should perform requests as expected', async () => {
      const { body: resp } = await fac.delete('/delete_test', reqOpts)
      assert.strictEqual(resp, 'bar')
      assert.deepStrictEqual(body, { foo: 'bar' })
    })

    s.check('should support callbacks', (done) => {
      fac.delete('/delete_test', reqOpts, (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'bar')
        assert.deepStrictEqual(body, { foo: 'bar' })
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.delete('/delete_test', (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.body, 'bar')
        assert.deepStrictEqual(body, {})
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { body: resp } = await fac.delete('/delete_test')
      assert.strictEqual(resp, 'bar')
      assert.deepStrictEqual(body, {})
    })
  })

  s.suite('head tests', (s) => {
    s.check('should perform requests as expected', async () => {
      const { headers } = await fac.head('/get_test', { headers: { foo: 'bar' } })
      assert.strictEqual(headers['content-type'], 'text/html; charset=utf-8')
    })

    s.check('should support callbacks', (done) => {
      fac.head('/get_test', { headers: { foo: 'bar' } }, (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8')
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.head('/get_test', (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8')
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { headers } = await fac.head('/get_test')
      assert.strictEqual(headers['content-type'], 'text/html; charset=utf-8')
    })
  })

  s.suite('options tests', (s) => {
    s.check('should perform requests as expected', async () => {
      const { headers } = await fac.options('/get_test', { headers: { foo: 'bar' } })
      assert.strictEqual(headers.allow, 'GET,HEAD')
    })

    s.check('should support callbacks', (done) => {
      fac.options('/get_test', { headers: { foo: 'bar' } }, (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.headers.allow, 'GET,HEAD')
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.options('/get_test', (err, res) => {
        assert.strictEqual(err, null)
        assert.strictEqual(res.headers.allow, 'GET,HEAD')
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { headers } = await fac.options('/get_test')
      assert.strictEqual(headers.allow, 'GET,HEAD')
    })
  })
})
