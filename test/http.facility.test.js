'use strict'

const suite = require('./suite')

const chai = require('chai')
const stream = require('stream')
const express = require('express')
const fs = require('fs')
const http = require('http')
const HttpFacility = require('../')
const { HttpError } = HttpFacility
const sinon = require('sinon')
const { expect } = chai.use(require('dirty-chai'))
  .use(require('chai-as-promised'))
const { format } = require('util')
const { join } = require('path')
const CacheableLookup = require('cacheable-lookup')

suite('http facility tests', (s) => {
  let srv = null
  const app = express()
  let fac = new HttpFacility({}, { baseUrl: 'http://127.0.0.1:7070' }, { env: 'test' })
  let sockets

  s.before((done) => {
    sockets = new Set()
    fac.start((err) => {
      if (err) return done(err)

      app.use(express.json())
      srv = app.listen(7070, () => {
        srv.on('connection', (socket) => {
          sockets.add(socket)
          socket.on('close', () => sockets.delete(socket))
        })
        done()
      })
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
        expect(fac.baseUrl).to.be.equal('')
        done()
      })
    })
  })

  s.suite('_response tests', (s) => {
    s.check('should perform call callback when provided', (done) => {
      fac._response(null, 123, {}, (err, res) => {
        expect(err).to.be.null()
        expect(res).to.be.deep.equal({ body: 123, headers: {} })
        done()
      })
    })

    s.check('should reject promise when no callback is provided and error is present', async () => {
      await expect(
        fac._response(new Error('FOO'), 123, {})
      ).to.be.rejectedWith('FOO')
    })

    s.check('should resolve promise when no callback is provided and error is falsy', async () => {
      const res = await fac._response(null, 123, {})
      expect(res).to.be.deep.equal({ body: 123, headers: {} })
    })
  })

  s.suite('request tests', (s) => {
    let body = null

    s.afterEach(() => {
      body = null
    })

    s.check('should throw error on invalid url', async () => {
      fac.baseUrl = ''

      await expect(
        fac.request('foo/bar')
      ).to.be.rejectedWith('Only absolute URLs are supported')
    })

    s.check('should throw error on invalid request params', async () => {
      await expect(
        fac.request('http://127.0.0.1:7070', { method: 'cut' })
      ).to.be.rejectedWith('ERR_HTTP: 400 - Bad Request')
    })

    s.check('should parse http errors as expected', async () => {
      app.get('/foo/bar/1', (req, res) => {
        res.status(500).json({ auth: false })
      })

      let httpErr = null
      try {
        await fac.request('/foo/bar/1')
      } catch (err) {
        httpErr = err
      }

      expect(httpErr).to.be.instanceOf(HttpError)
      expect(httpErr.message).to.be.equal('ERR_HTTP: 500 - Internal Server Error')
      expect(httpErr.status).to.be.equal(500)
      expect(httpErr.statusText).to.be.equal('Internal Server Error')
      expect(httpErr.response).to.be.equal('{"auth":false}')
      expect(httpErr.headers).to.be.an('object')
    })

    s.check('should support paths when base url is set', async () => {
      app.get('/foo/bar/2', (req, res) => {
        res.send('test')
      })

      const { body: resp } = await fac.request('foo/bar/2', { method: 'get' })
      expect(resp).to.be.equal('test')
    })

    s.check('should ignore leading slashes from url while concatenating url', async () => {
      app.get('/foo/bar/3', (req, res) => {
        res.send('test')
      })

      const { body: resp } = await fac.request('/foo/bar/3', { method: 'get' })
      expect(resp).to.be.equal('test')
    })

    s.check('should ignore base url when path is full url', async () => {
      const { body: resp } = await fac.request('https://www.google.com', { method: 'get' })
      expect(resp).to.be.include('<html')
    })

    s.check('should support body encodings', async () => {
      app.post('/foo/bar/4', (req, res) => {
        body = req.body
        res.json({ success: true })
      })

      const reqOpts = {
        method: 'post',
        body: { data: 'test' },
        encoding: 'json'
      }
      const { body: resp } = await fac.request('/foo/bar/4', reqOpts)

      expect(resp).to.be.deep.equal({ success: true })
      expect(body).to.be.deep.equal({ data: 'test' })
    })

    s.check('should support different encodings for request and response', async () => {
      app.post('/foo/bar/5', (req, res) => {
        body = req.body
        res.send('test')
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

      expect(resp).to.be.deep.equal('test')
      expect(body).to.be.deep.equal({ data: 'test' })
    })

    s.check('should return text encoding by default on response', async () => {
      app.post('/foo/bar/6', (req, res) => {
        body = req.body
        res.send('<test />')
      })

      const reqOpts = {
        method: 'post',
        body: { data: 'test' },
        encoding: {
          req: 'json'
        }
      }
      const { body: resp } = await fac.request('/foo/bar/6', reqOpts)

      expect(resp).to.be.deep.equal('<test />')
      expect(body).to.be.deep.equal({ data: 'test' })
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

      expect(resp).to.be.deep.equal({ success: true })
      expect(body).to.be.deep.equal({ data: 'test' })
    })

    s.check('should use buffer encoding on response when response type is not supported', async () => {
      app.post('/foo/bar/7', (req, res) => {
        body = req.body
        res.send('<test />')
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

      expect(resp).to.be.instanceOf(Buffer)
      expect(resp.toString('utf-8')).to.be.deep.equal('<test />')
      expect(body).to.be.deep.equal({ data: 'test' })
    })

    s.check('should support callbacks', (done) => {
      fac.request('/foo/bar/3', { method: 'get' }, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('test')
        done()
      })
    })

    s.check('should handle errors in callbacks', (done) => {
      fac.request('/foo/bar/1', { method: 'get' }, (err) => {
        expect(err).to.be.instanceOf(HttpError)
        expect(err.message).to.be.equal('ERR_HTTP: 500 - Internal Server Error')
        expect(err.status).to.be.equal(500)
        expect(err.statusText).to.be.equal('Internal Server Error')
        expect(err.response).to.be.equal('{"auth":false}')
        expect(err.headers).to.be.be.an('object')
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.request('/foo/bar/3', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('test')
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

      expect(resp).to.be.deep.equal('{"success":true}')
      expect(body).to.be.deep.equal({ data: 'test' })
    })

    s.check('should support redirect', async () => {
      const { body: resp } = await fac.request('http://google.com', { method: 'get', redirect: true })
      expect(resp).to.be.include('<html')

      await expect(
        fac.request('http://google.com', { method: 'get', redirect: false })
      ).to.be.rejectedWith('ERR_HTTP: 301 - Moved Permanently')
    })

    s.check('should support user agents', async () => {
      const agent = new http.Agent({ keepAlive: false })
      const { body: resp } = await fac.request('/foo/bar/3', { method: 'get', agent })
      expect(resp).to.be.equal('test')
    })

    s.check('should support timeout', async () => {
      app.get('/foo/bar/timeout', (req, res) => {
        setTimeout(() => res.send('test'), 100)
      })

      await expect(
        fac.request('/foo/bar/timeout', { method: 'get', timeout: 10 })
      ).to.be.rejectedWith('network timeout at: http://127.0.0.1:7070/foo/bar/timeout')
    })

    s.check('should throw error when encoding is wrong', async () => {
      await expect(
        fac.request('/foo/bar/3', { method: 'get', encoding: 'json' })
      ).to.be.rejectedWith('invalid json response body')
    })

    s.check('should support debugging', async () => {
      let log = null
      const logStub = sinon.stub(console, 'error').callsFake((...params) => {
        log = format(...params)
      })
      fac.debug = true

      app.get('/foo/bar/8', (req, res) => {
        res.status(500).send('test')
      })

      await expect(
        fac.request('/foo/bar/8', { method: 'get', encoding: 'json' })
      ).to.be.rejectedWith('ERR_HTTP: 500 - Internal Server Error')
      expect(log).to.contain('invalid json response body')

      logStub.reset()
      fac.debug = false
    })

    s.check('should support head method', async () => {
      const { headers } = await fac.request('https://api-pub.bitfinex.com/v2/conf/pub:list:currency', { method: 'head' })
      expect(headers['content-type']).to.contain('application/json')
    })

    s.check('should support options method', async () => {
      const { headers } = await fac.request('https://api-pub.bitfinex.com/v2/conf/pub:list:currency', { method: 'options' })
      expect(headers.allow).to.include('GET')
    })

    s.check('should support streams', async () => {
      const readfile = join(__dirname, 'bfx.png')
      const writefile = join(__dirname, 'out.png')

      app.get('/file', (req, res) => {
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

      expect(fs.existsSync(writefile)).to.be.true()
    })

    s.check('should support qs params', async () => {
      app.get('/foo/bar/9', (req, res) => {
        res.json(req.query)
      })

      let resp = await fac.request('/foo/bar/9', { method: 'get', encoding: 'json', qs: { a: 1, b: 'c' } })
      expect(resp.body).to.be.deep.equal({ a: '1', b: 'c' })

      resp = await fac.request('/foo/bar/9', { method: 'get', encoding: 'json', qs: [['a', 1], ['b', 'c']] })
      expect(resp.body).to.be.deep.equal({ a: '1', b: 'c' })

      resp = await fac.request('/foo/bar/9', { method: 'get', encoding: 'json', qs: 'a=1&b=c' })
      expect(resp.body).to.be.deep.equal({ a: '1', b: 'c' })

      resp = await fac.request('/foo/bar/9?', { method: 'get', encoding: 'json', qs: 'a=1&b=c' })
      expect(resp.body).to.be.deep.equal({ a: '1', b: 'c' })

      resp = await fac.request('/foo/bar/9', { method: 'get', encoding: 'json', qs: 123 })
      expect(resp.body).to.be.deep.equal({ 123: '' })

      fac = new HttpFacility({}, { baseUrl: 'http://127.0.0.1:7070', qs: { a: 2, d: 'e' } }, { env: 'test' })
      await new Promise((resolve, reject) => fac.start((err) => err ? reject(err) : resolve()))
      resp = await fac.request('/foo/bar/9?', { method: 'get', encoding: 'json', qs: 'a=1&b=c' })
      expect(resp.body).to.be.deep.equal({ a: ['2', '1'], b: 'c', d: 'e' })
    })

    s.check('should support basic authorization', async () => {
      app.get('/foo/bar/basic-auth', (req, res) => {
        res.send(req.headers.authorization)
      })

      const resp = await fac.request('/foo/bar/basic-auth', {
        method: 'get',
        auth: {
          username: 'user',
          password: 'pass'
        }
      })
      expect(resp.body).to.eq(`Basic ${Buffer.from('user:pass').toString('base64')}`)
    })

    s.check('should not send basic authorization', async () => {
      app.get('/foo/bar/no-basic-auth', (req, res) => {
        res.send(req.headers.authorization)
      })

      const resp = await fac.request('/foo/bar/no-basic-auth', { method: 'get' })
      expect(resp.body).to.eq('')
    })

    s.check('should support abort signals', async () => {
      app.get('/foo/bar/signal', () => { })

      const abortController = new AbortController()
      setTimeout(() => {
        abortController.abort()
      }, 1000)

      await expect(
        fac.request('/foo/bar/signal', { method: 'get', timeout: 30000, signal: abortController.signal })
      ).to.be.rejectedWith(/aborted/)
    })

    s.suite('DNS caching', (s) => {
      s.beforeEach(() => {
        fac.cacheableLookup._cache.clear()
        fac.opts.dnsCaching = false
      })

      s.check('should not perform dns caching by default', async () => {
        await fac.request('https://example.com', { method: 'get', timeout: 1000 })

        expect(fac.cacheableLookup._cache.get('example.com')).to.deep.eq(undefined)
      })

      s.check('should support dns caching for https requests', async () => {
        await fac.request('https://example.com', { method: 'get', timeout: 1000, dnsCaching: true })

        const expectedAddress = await lookupDomain('example.com')
        expect(fac.cacheableLookup._cache.get('example.com').some(e => e.address === expectedAddress)).to.be.true()
      })

      s.check('should support dns caching for http requests', async () => {
        await fac.request('http://example.com', { method: 'get', timeout: 1000, dnsCaching: true })

        const expectedAddress = await lookupDomain('example.com')
        expect(fac.cacheableLookup._cache.get('example.com').some(e => e.address === expectedAddress)).to.be.true()
      })

      s.check('can be activated by default through fac opts', async () => {
        fac.opts.dnsCaching = true

        await fac.request('https://example.com', { method: 'get', timeout: 1000 })

        const expectedAddress = await lookupDomain('example.com')
        expect(fac.cacheableLookup._cache.get('example.com').some(e => e.address === expectedAddress)).to.be.true()
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
      app.get('/foo/bar/slow', (req, res) => {
        const delay = parseInt(req.query.delay) || 3000
        setTimeout(() => res.send('slow response'), delay)
      })

      abortFac = new HttpFacility({}, { baseUrl: 'http://127.0.0.1:7070', abortTimeout: 500 }, { env: 'test' })
      abortFac.start(done)
    })

    s.after((done) => {
      abortFac.stop(done)
    })

    s.check('should default abortTimeout to 0 when not configured', () => {
      expect(fac.abortTimeout).to.be.equal(0)
    })

    s.check('should set abortTimeout from opts', () => {
      expect(abortFac.abortTimeout).to.be.equal(500)
    })

    s.check('should abort slow requests with facility-level abortTimeout', async () => {
      await expect(
        abortFac.request('/foo/bar/slow?delay=3000', { timeout: 30000 })
      ).to.be.rejectedWith(/aborted/)
    })

    s.check('should succeed when request completes before abortTimeout', async () => {
      const { body: resp } = await abortFac.request('/foo/bar/slow?delay=50', { timeout: 30000 })
      expect(resp).to.be.equal('slow response')
    })

    s.check('should allow per-request abortTimeout to override facility-level', async () => {
      const { body: resp } = await abortFac.request('/foo/bar/slow?delay=200', { abortTimeout: 2000, timeout: 30000 })
      expect(resp).to.be.equal('slow response')
    })

    s.check('should abort with per-request abortTimeout on fac without default', async () => {
      await expect(
        fac.request('/foo/bar/slow?delay=3000', { abortTimeout: 200, timeout: 30000 })
      ).to.be.rejectedWith(/aborted/)
    })

    s.check('should not create auto-controller when caller provides signal', async () => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 100)

      await expect(
        abortFac.request('/foo/bar/slow?delay=3000', { signal: controller.signal, abortTimeout: 30000, timeout: 30000 })
      ).to.be.rejectedWith(/aborted/)
    })

    s.check('should work with callback pattern', async () => {
      const result = await new Promise((resolve) => {
        abortFac.request('/foo/bar/slow?delay=3000', { timeout: 30000 }, (err) => {
          resolve(err)
        })
      })
      expect(result).to.not.be.null()
      expect(result.name).to.be.equal('AbortError')
    })

    s.check('should work through convenience methods', async () => {
      await expect(
        abortFac.get('/foo/bar/slow?delay=3000', { timeout: 30000 })
      ).to.be.rejectedWith(/aborted/)
    })
  })

  s.suite('_methodRequest tests', (s) => {
    s.before(() => {
      app.get('/method_request_test', (req, res) => {
        res.send('foo')
      })
    })

    s.check('should perform requests as expected', async () => {
      const { body: resp } = await fac._methodRequest('/method_request_test', 'get', { method: 'post' })
      expect(resp).to.be.equal('foo')
    })

    s.check('should support callbacks', (done) => {
      fac._methodRequest('/method_request_test', 'get', { method: 'post' }, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('foo')
        done()
      })
    })

    s.check('should support callback as 3nd arg', (done) => {
      fac._methodRequest('/method_request_test', 'get', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('foo')
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { body: resp } = await fac._methodRequest('/method_request_test', 'get')
      expect(resp).to.be.equal('foo')
    })
  })

  s.suite('get tests', (s) => {
    s.before(() => {
      app.get('/get_test', (req, res) => {
        res.send('test')
      })
    })

    s.check('should perform requests as expected', async () => {
      const { body: resp } = await fac.get('/get_test', { method: 'post' })
      expect(resp).to.be.equal('test')
    })

    s.check('should support callbacks', (done) => {
      fac.get('/get_test', { method: 'post' }, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('test')
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.get('/get_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('test')
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { body: resp } = await fac.get('/get_test')
      expect(resp).to.be.equal('test')
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
      app.post('/post_test', express.urlencoded({ extended: true }), (req, res) => {
        body = req.body
        res.send('bar')
      })
    })

    s.afterEach(() => {
      body = null
    })

    s.check('should perform requests as expected', async () => {
      const { body: resp } = await fac.post('/post_test', reqOpts)
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({ foo: 'bar' })
    })

    s.check('should support callbacks', (done) => {
      fac.post('/post_test', reqOpts, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({ foo: 'bar' })
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.post('/post_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({})
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { body: resp } = await fac.post('/post_test')
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({})
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
      app.put('/put_test', express.urlencoded({ extended: true }), (req, res) => {
        body = req.body
        res.send('bar')
      })
    })

    s.afterEach(() => {
      body = null
    })

    s.check('should perform requests as expected', async () => {
      const { body: resp } = await fac.put('/put_test', reqOpts)
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({ foo: 'bar' })
    })

    s.check('should support callbacks', (done) => {
      fac.put('/put_test', reqOpts, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({ foo: 'bar' })
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.put('/put_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({})
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { body: resp } = await fac.put('/put_test')
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({})
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
      app.patch('/patch_test', express.urlencoded({ extended: true }), (req, res) => {
        body = req.body
        res.send('bar')
      })
    })

    s.afterEach(() => {
      body = null
    })

    s.check('should perform requests as expected', async () => {
      const { body: resp } = await fac.patch('/patch_test', reqOpts)
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({ foo: 'bar' })
    })

    s.check('should support callbacks', (done) => {
      fac.patch('/patch_test', reqOpts, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({ foo: 'bar' })
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.patch('/patch_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({})
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { body: resp } = await fac.patch('/patch_test')
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({})
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
      app.delete('/delete_test', express.urlencoded({ extended: true }), (req, res) => {
        body = req.body
        res.send('bar')
      })
    })

    s.afterEach(() => {
      body = null
    })

    s.check('should perform requests as expected', async () => {
      const { body: resp } = await fac.delete('/delete_test', reqOpts)
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({ foo: 'bar' })
    })

    s.check('should support callbacks', (done) => {
      fac.delete('/delete_test', reqOpts, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({ foo: 'bar' })
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.delete('/delete_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({})
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { body: resp } = await fac.delete('/delete_test')
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({})
    })
  })

  s.suite('head tests', (s) => {
    s.check('should perform requests as expected', async () => {
      const { headers } = await fac.head('/get_test', { headers: { foo: 'bar' } })
      expect(headers['content-type']).to.be.equal('text/html; charset=utf-8')
    })

    s.check('should support callbacks', (done) => {
      fac.head('/get_test', { headers: { foo: 'bar' } }, (err, res) => {
        expect(err).to.be.null()
        expect(res.headers['content-type']).to.be.equal('text/html; charset=utf-8')
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.head('/get_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.headers['content-type']).to.be.equal('text/html; charset=utf-8')
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { headers } = await fac.head('/get_test')
      expect(headers['content-type']).to.be.equal('text/html; charset=utf-8')
    })
  })

  s.suite('options tests', (s) => {
    s.check('should perform requests as expected', async () => {
      const { headers } = await fac.options('/get_test', { headers: { foo: 'bar' } })
      expect(headers.allow).to.be.equal('GET,HEAD')
    })

    s.check('should support callbacks', (done) => {
      fac.options('/get_test', { headers: { foo: 'bar' } }, (err, res) => {
        expect(err).to.be.null()
        expect(res.headers.allow).to.be.equal('GET,HEAD')
        done()
      })
    })

    s.check('should support callback as 2nd arg', (done) => {
      fac.options('/get_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.headers.allow).to.be.equal('GET,HEAD')
        done()
      })
    })

    s.check('should work without optional args', async () => {
      const { headers } = await fac.options('/get_test')
      expect(headers.allow).to.be.equal('GET,HEAD')
    })
  })
})
