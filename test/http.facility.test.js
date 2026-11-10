'use strict'

const { test } = require('brittle')

const stream = require('stream')
const fs = require('fs')
const http = require('http')
const HttpFacility = require('../')
const { HttpError } = HttpFacility
const { format } = require('util')
const { join } = require('path')
const CacheableLookup = require('cacheable-lookup')

const rejectsWith = (t, promise, expected) => t.exception.all(promise, {
  message: typeof expected === 'string'
    ? new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    : expected
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

test('http facility tests', async (t) => {
  let srv = null
  const fac = new HttpFacility({}, { baseUrl: 'http://127.0.0.1:7070' }, { env: 'test' })
  const sockets = new Set()

  await new Promise((resolve, reject) => fac.start((err) => err ? reject(err) : resolve()))

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
  t.teardown(async () => {
    await new Promise((resolve, reject) => fac.stop((err) => err ? reject(err) : resolve()))
    if (srv.listening) {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve, reject) => srv.close((err) => err ? reject(err) : resolve()))
    }
  }, { force: true })
  await new Promise((resolve, reject) => srv.listen(7070, (err) => err ? reject(err) : resolve()))

  t.test('constructor tests', async (t) => {
    t.test('should set base url to empty string when missing', async (t) => {
      await new Promise((resolve) => {
        const fac = new HttpFacility({}, {}, { env: 'test' })

        fac.start(() => {
          t.is(fac.baseUrl, '')
          resolve()
        })
      })
    })
  })

  t.test('_response tests', async (t) => {
    t.test('should perform call callback when provided', async (t) => {
      await new Promise((resolve) => {
        fac._response(null, 123, {}, (err, res) => {
          t.is(err, null)
          t.alike(res, { body: 123, headers: {} })
          resolve()
        })
      })
    })

    t.test('should reject promise when no callback is provided and error is present', async (t) => {
      await rejectsWith(t, fac._response(new Error('FOO'), 123, {}), 'FOO')
    })

    t.test('should resolve promise when no callback is provided and error is falsy', async (t) => {
      const res = await fac._response(null, 123, {})
      t.alike(res, { body: 123, headers: {} })
    })
  })

  t.test('request tests', async (t) => {
    let body = null

    t.test('should throw error on invalid url', async (t) => {
      const noBaseUrlFac = new HttpFacility({}, {}, { env: 'test' })
      await new Promise((resolve, reject) => noBaseUrlFac.start((err) => err ? reject(err) : resolve()))
      t.teardown(() => new Promise((resolve, reject) => noBaseUrlFac.stop((err) => err ? reject(err) : resolve())), { force: true })

      await rejectsWith(t, noBaseUrlFac.request('foo/bar'), 'Only absolute URLs are supported')
    })

    t.test('should throw error on invalid request params', async (t) => {
      await rejectsWith(t, fac.request('http://127.0.0.1:7070', { method: 'cut' }), 'ERR_HTTP: 400 - Bad Request')
    })

    t.test('should parse http errors as expected', async (t) => {
      route('GET', '/foo/bar/1', (req, res) => {
        sendJson(res, { auth: false }, 500)
      })

      let httpErr = null
      try {
        await fac.request('/foo/bar/1')
      } catch (err) {
        httpErr = err
      }

      t.ok(httpErr instanceof HttpError)
      t.is(httpErr.message, 'ERR_HTTP: 500 - Internal Server Error')
      t.is(httpErr.status, 500)
      t.is(httpErr.statusText, 'Internal Server Error')
      t.is(httpErr.response, '{"auth":false}')
      t.ok(httpErr.headers !== null && typeof httpErr.headers === 'object')
    })

    t.test('should support paths when base url is set', async (t) => {
      route('GET', '/foo/bar/2', (req, res) => {
        sendText(res, 'test')
      })

      const { body: resp } = await fac.request('foo/bar/2', { method: 'get' })
      t.is(resp, 'test')
    })

    t.test('should ignore leading slashes from url while concatenating url', async (t) => {
      route('GET', '/foo/bar/3', (req, res) => {
        sendText(res, 'test')
      })

      const { body: resp } = await fac.request('/foo/bar/3', { method: 'get' })
      t.is(resp, 'test')
    })

    t.test('should ignore base url when path is full url', async (t) => {
      const { body: resp } = await fac.request('https://www.google.com', { method: 'get' })
      t.ok(resp.includes('<html'))
    })

    t.test('should support body encodings', async (t) => {
      body = null
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

      t.alike(resp, { success: true })
      t.alike(body, { data: 'test' })
    })

    t.test('should support different encodings for request and response', async (t) => {
      body = null
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

      t.alike(resp, 'test')
      t.alike(body, { data: 'test' })
    })

    t.test('should return text encoding by default on response', async (t) => {
      body = null
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

      t.alike(resp, '<test />')
      t.alike(body, { data: 'test' })
    })

    t.test('should return text encoding by default on request body', async (t) => {
      body = null
      const reqOpts = {
        method: 'post',
        body: JSON.stringify({ data: 'test' }),
        headers: { 'content-type': 'application/json' },
        encoding: {
          res: 'json'
        }
      }
      const { body: resp } = await fac.request('/foo/bar/4', reqOpts)

      t.alike(resp, { success: true })
      t.alike(body, { data: 'test' })
    })

    t.test('should use buffer encoding on response when response type is not supported', async (t) => {
      body = null
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

      t.ok(resp instanceof Buffer)
      t.alike(resp.toString('utf-8'), '<test />')
      t.alike(body, { data: 'test' })
    })

    t.test('should support callbacks', async (t) => {
      await new Promise((resolve) => {
        fac.request('/foo/bar/3', { method: 'get' }, (err, res) => {
          t.is(err, null)
          t.is(res.body, 'test')
          resolve()
        })
      })
    })

    t.test('should handle errors in callbacks', async (t) => {
      await new Promise((resolve) => {
        fac.request('/foo/bar/1', { method: 'get' }, (err) => {
          t.ok(err instanceof HttpError)
          t.is(err.message, 'ERR_HTTP: 500 - Internal Server Error')
          t.is(err.status, 500)
          t.is(err.statusText, 'Internal Server Error')
          t.is(err.response, '{"auth":false}')
          t.ok(err.headers !== null && typeof err.headers === 'object')
          resolve()
        })
      })
    })

    t.test('should support callback as 2nd arg', async (t) => {
      await new Promise((resolve) => {
        fac.request('/foo/bar/3', (err, res) => {
          t.is(err, null)
          t.is(res.body, 'test')
          resolve()
        })
      })
    })

    t.test('should support headers', async (t) => {
      body = null
      const reqOpts = {
        method: 'post',
        body: JSON.stringify({ data: 'test' }),
        headers: { 'content-type': 'application/json' }
      }
      const { body: resp } = await fac.request('/foo/bar/4', reqOpts)

      t.alike(resp, '{"success":true}')
      t.alike(body, { data: 'test' })
    })

    t.test('should support redirect', async (t) => {
      const { body: resp } = await fac.request('http://google.com', { method: 'get', redirect: true })
      t.ok(resp.includes('<html'))

      await rejectsWith(t, fac.request('http://google.com', { method: 'get', redirect: false }), 'ERR_HTTP: 301 - Moved Permanently')
    })

    t.test('should support user agents', async (t) => {
      const agent = new http.Agent({ keepAlive: false })
      const { body: resp } = await fac.request('/foo/bar/3', { method: 'get', agent })
      t.is(resp, 'test')
    })

    t.test('should support timeout', async (t) => {
      route('GET', '/foo/bar/timeout', (req, res) => {
        setTimeout(() => sendText(res, 'test'), 100)
      })

      await rejectsWith(t, fac.request('/foo/bar/timeout', { method: 'get', timeout: 10 }), 'network timeout at: http://127.0.0.1:7070/foo/bar/timeout')
    })

    t.test('should throw error when encoding is wrong', async (t) => {
      await rejectsWith(t, fac.request('/foo/bar/3', { method: 'get', encoding: 'json' }), 'invalid json response body')
    })

    t.test('should support debugging', async (t) => {
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

        await rejectsWith(t, fac.request('/foo/bar/8', { method: 'get', encoding: 'json' }), 'ERR_HTTP: 500 - Internal Server Error')
        t.ok(log.includes('invalid json response body'))
      } finally {
        console.error = originalError
        fac.debug = false
      }
    })

    t.test('should support head method', async (t) => {
      const { headers } = await fac.request('https://api-pub.bitfinex.com/v2/conf/pub:list:currency', { method: 'head' })
      t.ok(headers['content-type'].includes('application/json'))
    })

    t.test('should support options method', async (t) => {
      const { headers } = await fac.request('https://api-pub.bitfinex.com/v2/conf/pub:list:currency', { method: 'options' })
      t.ok(headers.allow.includes('GET'))
    })

    t.test('should support streams', async (t) => {
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

      t.is(fs.existsSync(writefile), true)
    })

    t.test('should support qs params', async (t) => {
      route('GET', '/foo/bar/9', (req, res) => {
        sendJson(res, req.query)
      })

      let resp = await fac.request('/foo/bar/9', { method: 'get', encoding: 'json', qs: { a: 1, b: 'c' } })
      t.alike(resp.body, { a: '1', b: 'c' })

      resp = await fac.request('/foo/bar/9', { method: 'get', encoding: 'json', qs: [['a', 1], ['b', 'c']] })
      t.alike(resp.body, { a: '1', b: 'c' })

      resp = await fac.request('/foo/bar/9', { method: 'get', encoding: 'json', qs: 'a=1&b=c' })
      t.alike(resp.body, { a: '1', b: 'c' })

      resp = await fac.request('/foo/bar/9?', { method: 'get', encoding: 'json', qs: 'a=1&b=c' })
      t.alike(resp.body, { a: '1', b: 'c' })

      resp = await fac.request('/foo/bar/9', { method: 'get', encoding: 'json', qs: 123 })
      t.alike(resp.body, { 123: '' })

      const qsFac = new HttpFacility({}, { baseUrl: 'http://127.0.0.1:7070', qs: { a: 2, d: 'e' } }, { env: 'test' })
      await new Promise((resolve, reject) => qsFac.start((err) => err ? reject(err) : resolve()))
      t.teardown(() => new Promise((resolve, reject) => {
        qsFac.stop((err) => err ? reject(err) : resolve())
      }), { force: true })
      resp = await qsFac.request('/foo/bar/9?', { method: 'get', encoding: 'json', qs: 'a=1&b=c' })
      t.alike(resp.body, { a: ['2', '1'], b: 'c', d: 'e' })
    })

    t.test('should support basic authorization', async (t) => {
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
      t.is(resp.body, `Basic ${Buffer.from('user:pass').toString('base64')}`)
    })

    t.test('should not send basic authorization', async (t) => {
      route('GET', '/foo/bar/no-basic-auth', (req, res) => {
        sendText(res, req.headers.authorization)
      })

      const resp = await fac.request('/foo/bar/no-basic-auth', { method: 'get' })
      t.is(resp.body, '')
    })

    t.test('should support abort signals', async (t) => {
      route('GET', '/foo/bar/signal', () => { })

      const abortController = new AbortController()
      setTimeout(() => {
        abortController.abort()
      }, 1000)

      await rejectsWith(t, fac.request('/foo/bar/signal', { method: 'get', timeout: 30000, signal: abortController.signal }), /aborted/)
    })

    t.test('DNS caching', async (t) => {
      const lookupDomain = async (domain) => {
        const entry = await (new CacheableLookup()).lookupAsync(domain)
        return entry.address
      }
      const createDnsFac = async (t) => {
        const dnsFac = new HttpFacility({}, {}, { env: 'test' })
        await new Promise((resolve, reject) => dnsFac.start((err) => err ? reject(err) : resolve()))
        t.teardown(() => new Promise((resolve, reject) => dnsFac.stop((err) => err ? reject(err) : resolve())), { force: true })
        return dnsFac
      }

      t.test('should not perform dns caching by default', async (t) => {
        const dnsFac = await createDnsFac(t)
        await dnsFac.request('https://example.com', { method: 'get', timeout: 1000 })

        t.alike(dnsFac.cacheableLookup._cache.get('example.com'), undefined)
      })

      t.test('should support dns caching for https requests', async (t) => {
        const dnsFac = await createDnsFac(t)
        await dnsFac.request('https://example.com', { method: 'get', timeout: 1000, dnsCaching: true })

        const expectedAddress = await lookupDomain('example.com')
        t.is(dnsFac.cacheableLookup._cache.get('example.com').some(e => e.address === expectedAddress), true)
      })

      t.test('should support dns caching for http requests', async (t) => {
        const dnsFac = await createDnsFac(t)
        await dnsFac.request('http://example.com', { method: 'get', timeout: 1000, dnsCaching: true })

        const expectedAddress = await lookupDomain('example.com')
        t.is(dnsFac.cacheableLookup._cache.get('example.com').some(e => e.address === expectedAddress), true)
      })

      t.test('can be activated by default through fac opts', async (t) => {
        const dnsFac = await createDnsFac(t)
        dnsFac.opts.dnsCaching = true

        await dnsFac.request('https://example.com', { method: 'get', timeout: 1000 })

        const expectedAddress = await lookupDomain('example.com')
        t.is(dnsFac.cacheableLookup._cache.get('example.com').some(e => e.address === expectedAddress), true)
      })
    })
  })

  t.test('abortTimeout tests', async (t) => {
    let abortFac = null

    route('GET', '/foo/bar/slow', (req, res) => {
      const delay = parseInt(req.query.delay) || 3000
      setTimeout(() => sendText(res, 'slow response'), delay)
    })

    abortFac = new HttpFacility({}, { baseUrl: 'http://127.0.0.1:7070', abortTimeout: 500 }, { env: 'test' })
    await new Promise((resolve, reject) => abortFac.start((err) => err ? reject(err) : resolve()))
    t.teardown(() => new Promise((resolve, reject) => {
      abortFac.stop((err) => err ? reject(err) : resolve())
    }), { force: true })

    t.test('should default abortTimeout to 0 when not configured', (t) => {
      t.is(fac.abortTimeout, 0)
    })

    t.test('should set abortTimeout from opts', (t) => {
      t.is(abortFac.abortTimeout, 500)
    })

    t.test('should abort slow requests with facility-level abortTimeout', async (t) => {
      await rejectsWith(t, abortFac.request('/foo/bar/slow?delay=3000', { timeout: 30000 }), /aborted/)
    })

    t.test('should succeed when request completes before abortTimeout', async (t) => {
      const { body: resp } = await abortFac.request('/foo/bar/slow?delay=50', { timeout: 30000 })
      t.is(resp, 'slow response')
    })

    t.test('should allow per-request abortTimeout to override facility-level', async (t) => {
      const { body: resp } = await abortFac.request('/foo/bar/slow?delay=200', { abortTimeout: 2000, timeout: 30000 })
      t.is(resp, 'slow response')
    })

    t.test('should abort with per-request abortTimeout on fac without default', async (t) => {
      await rejectsWith(t, fac.request('/foo/bar/slow?delay=3000', { abortTimeout: 200, timeout: 30000 }), /aborted/)
    })

    t.test('should not create auto-controller when caller provides signal', async (t) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 100)

      await rejectsWith(t, abortFac.request('/foo/bar/slow?delay=3000', { signal: controller.signal, abortTimeout: 30000, timeout: 30000 }), /aborted/)
    })

    t.test('should work with callback pattern', async (t) => {
      const result = await new Promise((resolve) => {
        abortFac.request('/foo/bar/slow?delay=3000', { timeout: 30000 }, (err) => {
          resolve(err)
        })
      })
      t.not(result, null)
      t.is(result.name, 'AbortError')
    })

    t.test('should work through convenience methods', async (t) => {
      await rejectsWith(t, abortFac.get('/foo/bar/slow?delay=3000', { timeout: 30000 }), /aborted/)
    })
  })

  t.test('_methodRequest tests', async (t) => {
    route('GET', '/method_request_test', (req, res) => {
      sendText(res, 'foo')
    })

    t.test('should perform requests as expected', async (t) => {
      const { body: resp } = await fac._methodRequest('/method_request_test', 'get', { method: 'post' })
      t.is(resp, 'foo')
    })

    t.test('should support callbacks', async (t) => {
      await new Promise((resolve) => {
        fac._methodRequest('/method_request_test', 'get', { method: 'post' }, (err, res) => {
          t.is(err, null)
          t.is(res.body, 'foo')
          resolve()
        })
      })
    })

    t.test('should support callback as 3nd arg', async (t) => {
      await new Promise((resolve) => {
        fac._methodRequest('/method_request_test', 'get', (err, res) => {
          t.is(err, null)
          t.is(res.body, 'foo')
          resolve()
        })
      })
    })

    t.test('should work without optional args', async (t) => {
      const { body: resp } = await fac._methodRequest('/method_request_test', 'get')
      t.is(resp, 'foo')
    })
  })

  t.test('get tests', async (t) => {
    route('GET', '/get_test', (req, res) => {
      sendText(res, 'test')
    })

    t.test('should perform requests as expected', async (t) => {
      const { body: resp } = await fac.get('/get_test', { method: 'post' })
      t.is(resp, 'test')
    })

    t.test('should support callbacks', async (t) => {
      await new Promise((resolve) => {
        fac.get('/get_test', { method: 'post' }, (err, res) => {
          t.is(err, null)
          t.is(res.body, 'test')
          resolve()
        })
      })
    })

    t.test('should support callback as 2nd arg', async (t) => {
      await new Promise((resolve) => {
        fac.get('/get_test', (err, res) => {
          t.is(err, null)
          t.is(res.body, 'test')
          resolve()
        })
      })
    })

    t.test('should work without optional args', async (t) => {
      const { body: resp } = await fac.get('/get_test')
      t.is(resp, 'test')
    })
  })

  t.test('post tests', async (t) => {
    const reqOpts = {
      method: 'get',
      body: 'foo=bar',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }

    route('POST', '/post_test', (req, res) => {
      res.setHeader('x-received-body', JSON.stringify(req.body))
      sendText(res, 'bar')
    })

    t.test('should perform requests as expected', async (t) => {
      const { body: resp, headers } = await fac.post('/post_test', reqOpts)
      t.is(resp, 'bar')
      t.alike(JSON.parse(headers['x-received-body']), { foo: 'bar' })
    })

    t.test('should support callbacks', async (t) => {
      await new Promise((resolve) => {
        fac.post('/post_test', reqOpts, (err, res) => {
          t.is(err, null)
          t.is(res.body, 'bar')
          t.alike(JSON.parse(res.headers['x-received-body']), { foo: 'bar' })
          resolve()
        })
      })
    })

    t.test('should support callback as 2nd arg', async (t) => {
      await new Promise((resolve) => {
        fac.post('/post_test', (err, res) => {
          t.is(err, null)
          t.is(res.body, 'bar')
          t.alike(JSON.parse(res.headers['x-received-body']), {})
          resolve()
        })
      })
    })

    t.test('should work without optional args', async (t) => {
      const { body: resp, headers } = await fac.post('/post_test')
      t.is(resp, 'bar')
      t.alike(JSON.parse(headers['x-received-body']), {})
    })
  })

  t.test('put tests', async (t) => {
    const reqOpts = {
      method: 'get',
      body: 'foo=bar',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }

    route('PUT', '/put_test', (req, res) => {
      res.setHeader('x-received-body', JSON.stringify(req.body))
      sendText(res, 'bar')
    })

    t.test('should perform requests as expected', async (t) => {
      const { body: resp, headers } = await fac.put('/put_test', reqOpts)
      t.is(resp, 'bar')
      t.alike(JSON.parse(headers['x-received-body']), { foo: 'bar' })
    })

    t.test('should support callbacks', async (t) => {
      await new Promise((resolve) => {
        fac.put('/put_test', reqOpts, (err, res) => {
          t.is(err, null)
          t.is(res.body, 'bar')
          t.alike(JSON.parse(res.headers['x-received-body']), { foo: 'bar' })
          resolve()
        })
      })
    })

    t.test('should support callback as 2nd arg', async (t) => {
      await new Promise((resolve) => {
        fac.put('/put_test', (err, res) => {
          t.is(err, null)
          t.is(res.body, 'bar')
          t.alike(JSON.parse(res.headers['x-received-body']), {})
          resolve()
        })
      })
    })

    t.test('should work without optional args', async (t) => {
      const { body: resp, headers } = await fac.put('/put_test')
      t.is(resp, 'bar')
      t.alike(JSON.parse(headers['x-received-body']), {})
    })
  })

  t.test('patch tests', async (t) => {
    const reqOpts = {
      method: 'get',
      body: 'foo=bar',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }

    route('PATCH', '/patch_test', (req, res) => {
      res.setHeader('x-received-body', JSON.stringify(req.body))
      sendText(res, 'bar')
    })

    t.test('should perform requests as expected', async (t) => {
      const { body: resp, headers } = await fac.patch('/patch_test', reqOpts)
      t.is(resp, 'bar')
      t.alike(JSON.parse(headers['x-received-body']), { foo: 'bar' })
    })

    t.test('should support callbacks', async (t) => {
      await new Promise((resolve) => {
        fac.patch('/patch_test', reqOpts, (err, res) => {
          t.is(err, null)
          t.is(res.body, 'bar')
          t.alike(JSON.parse(res.headers['x-received-body']), { foo: 'bar' })
          resolve()
        })
      })
    })

    t.test('should support callback as 2nd arg', async (t) => {
      await new Promise((resolve) => {
        fac.patch('/patch_test', (err, res) => {
          t.is(err, null)
          t.is(res.body, 'bar')
          t.alike(JSON.parse(res.headers['x-received-body']), {})
          resolve()
        })
      })
    })

    t.test('should work without optional args', async (t) => {
      const { body: resp, headers } = await fac.patch('/patch_test')
      t.is(resp, 'bar')
      t.alike(JSON.parse(headers['x-received-body']), {})
    })
  })

  t.test('delete tests', async (t) => {
    const reqOpts = {
      method: 'get',
      body: 'foo=bar',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }

    route('DELETE', '/delete_test', (req, res) => {
      res.setHeader('x-received-body', JSON.stringify(req.body))
      sendText(res, 'bar')
    })

    t.test('should perform requests as expected', async (t) => {
      const { body: resp, headers } = await fac.delete('/delete_test', reqOpts)
      t.is(resp, 'bar')
      t.alike(JSON.parse(headers['x-received-body']), { foo: 'bar' })
    })

    t.test('should support callbacks', async (t) => {
      await new Promise((resolve) => {
        fac.delete('/delete_test', reqOpts, (err, res) => {
          t.is(err, null)
          t.is(res.body, 'bar')
          t.alike(JSON.parse(res.headers['x-received-body']), { foo: 'bar' })
          resolve()
        })
      })
    })

    t.test('should support callback as 2nd arg', async (t) => {
      await new Promise((resolve) => {
        fac.delete('/delete_test', (err, res) => {
          t.is(err, null)
          t.is(res.body, 'bar')
          t.alike(JSON.parse(res.headers['x-received-body']), {})
          resolve()
        })
      })
    })

    t.test('should work without optional args', async (t) => {
      const { body: resp, headers } = await fac.delete('/delete_test')
      t.is(resp, 'bar')
      t.alike(JSON.parse(headers['x-received-body']), {})
    })
  })

  t.test('head tests', async (t) => {
    t.test('should perform requests as expected', async (t) => {
      const { headers } = await fac.head('/get_test', { headers: { foo: 'bar' } })
      t.is(headers['content-type'], 'text/html; charset=utf-8')
    })

    t.test('should support callbacks', async (t) => {
      await new Promise((resolve) => {
        fac.head('/get_test', { headers: { foo: 'bar' } }, (err, res) => {
          t.is(err, null)
          t.is(res.headers['content-type'], 'text/html; charset=utf-8')
          resolve()
        })
      })
    })

    t.test('should support callback as 2nd arg', async (t) => {
      await new Promise((resolve) => {
        fac.head('/get_test', (err, res) => {
          t.is(err, null)
          t.is(res.headers['content-type'], 'text/html; charset=utf-8')
          resolve()
        })
      })
    })

    t.test('should work without optional args', async (t) => {
      const { headers } = await fac.head('/get_test')
      t.is(headers['content-type'], 'text/html; charset=utf-8')
    })
  })

  t.test('options tests', async (t) => {
    t.test('should perform requests as expected', async (t) => {
      const { headers } = await fac.options('/get_test', { headers: { foo: 'bar' } })
      t.is(headers.allow, 'GET,HEAD')
    })

    t.test('should support callbacks', async (t) => {
      await new Promise((resolve) => {
        fac.options('/get_test', { headers: { foo: 'bar' } }, (err, res) => {
          t.is(err, null)
          t.is(res.headers.allow, 'GET,HEAD')
          resolve()
        })
      })
    })

    t.test('should support callback as 2nd arg', async (t) => {
      await new Promise((resolve) => {
        fac.options('/get_test', (err, res) => {
          t.is(err, null)
          t.is(res.headers.allow, 'GET,HEAD')
          resolve()
        })
      })
    })

    t.test('should work without optional args', async (t) => {
      const { headers } = await fac.options('/get_test')
      t.is(headers.allow, 'GET,HEAD')
    })
  })
})
