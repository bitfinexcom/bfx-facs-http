/* eslint-env mocha */

'use strict'

const chai = require('chai')
const endOfStream = require('end-of-stream')
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

describe('http facility tests', () => {
  let srv = null
  const app = express()
  let fac = new HttpFacility({}, { baseUrl: 'http://127.0.0.1:7070' }, { env: 'test' })

  before((done) => {
    fac.start((err) => {
      if (err) return done(err)

      app.use(express.json())
      srv = app.listen(7070)
      done()
    })
  })

  after((done) => {
    fac.stop((err) => {
      if (err) return done(err)
      srv.close(done)
    })
  })

  afterEach(() => {
    fac.baseUrl = 'http://127.0.0.1:7070'
  })

  describe('constructor tests', () => {
    it('should set base url to empty string when missing', (done) => {
      const fac = new HttpFacility({}, {}, { env: 'test' })

      fac.start(() => {
        expect(fac.baseUrl).to.be.equal('')
        done()
      })
    })
  })

  describe('_response tests', () => {
    it('should perform call callback when provided', (done) => {
      fac._response(null, 123, {}, (err, res) => {
        expect(err).to.be.null()
        expect(res).to.be.deep.equal({ body: 123, headers: {} })
        done()
      })
    })

    it('should reject promise when no callback is provided and error is present', async () => {
      await expect(
        fac._response(new Error('FOO'), 123, {})
      ).to.be.rejectedWith('FOO')
    })

    it('should resolve promise when no callback is provided and error is falsy', async () => {
      const res = await fac._response(null, 123, {})
      expect(res).to.be.deep.equal({ body: 123, headers: {} })
    })
  })

  describe('request tests', () => {
    let body = null

    afterEach(() => {
      body = null
    })

    it('should throw error on invalid url', async () => {
      fac.baseUrl = ''

      await expect(
        fac.request('foo/bar')
      ).to.be.rejectedWith('Only absolute URLs are supported')
    })

    it('should throw error on invalid request params', async () => {
      await expect(
        fac.request('http://127.0.0.1:7070', { method: 'cut' })
      ).to.be.rejectedWith('ERR_HTTP: 400 - Bad Request')
    })

    it('should parse http errors as expected', async () => {
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

    it('should support paths when base url is set', async () => {
      app.get('/foo/bar/2', (req, res) => {
        res.send('test')
      })

      const { body: resp } = await fac.request('foo/bar/2', { method: 'get' })
      expect(resp).to.be.equal('test')
    })

    it('should ignore leading slashes from url while concatenating url', async () => {
      app.get('/foo/bar/3', (req, res) => {
        res.send('test')
      })

      const { body: resp } = await fac.request('/foo/bar/3', { method: 'get' })
      expect(resp).to.be.equal('test')
    })

    it('should ignore base url when path is full url', async () => {
      const { body: resp } = await fac.request('https://www.google.com', { method: 'get' })
      expect(resp).to.be.include('<html')
    })

    it('should support body encodings', async () => {
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

    it('should support different encodings for request and response', async () => {
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

    it('should return text encoding by default on response', async () => {
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

    it('should return text encoding by default on request body', async () => {
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

    it('should use buffer encoding on response when response type is not supported', async () => {
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

    it('should support callbacks', (done) => {
      fac.request('/foo/bar/3', { method: 'get' }, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('test')
        done()
      })
    })

    it('should handle errors in callbacks', (done) => {
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

    it('should support callback as 2nd arg', (done) => {
      fac.request('/foo/bar/3', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('test')
        done()
      })
    })

    it('should support headers', async () => {
      const reqOpts = {
        method: 'post',
        body: JSON.stringify({ data: 'test' }),
        headers: { 'content-type': 'application/json' }
      }
      const { body: resp } = await fac.request('/foo/bar/4', reqOpts)

      expect(resp).to.be.deep.equal('{"success":true}')
      expect(body).to.be.deep.equal({ data: 'test' })
    })

    it('should support redirect', async () => {
      const { body: resp } = await fac.request('http://google.com', { method: 'get', redirect: true })
      expect(resp).to.be.include('<html')

      await expect(
        fac.request('http://google.com', { method: 'get', redirect: false })
      ).to.be.rejectedWith('ERR_HTTP: 301 - Moved Permanently')
    })

    it('should support user agents', async () => {
      const agent = new http.Agent({ keepAlive: false })
      const { body: resp } = await fac.request('/foo/bar/3', { method: 'get', agent })
      expect(resp).to.be.equal('test')
    })

    it('should support timeout', async () => {
      await expect(
        fac.request('/foo/bar/3', { method: 'get', timeout: 1 })
      ).to.be.rejectedWith('network timeout at: http://127.0.0.1:7070/foo/bar/3')
    })

    it('should throw error when encoding is wrong', async () => {
      await expect(
        fac.request('/foo/bar/3', { method: 'get', encoding: 'json' })
      ).to.be.rejectedWith('invalid json response body')
    })

    it('should support debugging', async () => {
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

    it('should support head method', async () => {
      const { headers } = await fac.request('https://api-pub.bitfinex.com/v2/conf/pub:list:currency', { method: 'head' })
      expect(headers['content-type']).to.contain('application/json')
    })

    it('should support options method', async () => {
      const { headers } = await fac.request('https://api-pub.bitfinex.com/v2/conf/pub:list:currency', { method: 'options' })
      expect(headers.allow).to.include('GET')
    })

    it('should support streams', async () => {
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
        const writer = fs.createWriteStream(writefile)
        endOfStream(writer, (err) => err ? reject(err) : resolve())
        resp.pipe(writer)
      })

      expect(fs.existsSync(writefile)).to.be.true()
    })

    it('should support qs params', async () => {
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

    it('should support basic authorization', async () => {
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

    it('should not send basic authorization', async () => {
      app.get('/foo/bar/no-basic-auth', (req, res) => {
        res.send(req.headers.authorization)
      })

      const resp = await fac.request('/foo/bar/no-basic-auth', { method: 'get' })
      expect(resp.body).to.eq('')
    })
  })

  describe('_methodRequest tests', () => {
    before(() => {
      app.get('/method_request_test', (req, res) => {
        res.send('foo')
      })
    })

    it('should perform requests as expected', async () => {
      const { body: resp } = await fac._methodRequest('/method_request_test', 'get', { method: 'post' })
      expect(resp).to.be.equal('foo')
    })

    it('should support callbacks', (done) => {
      fac._methodRequest('/method_request_test', 'get', { method: 'post' }, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('foo')
        done()
      })
    })

    it('should support callback as 3nd arg', (done) => {
      fac._methodRequest('/method_request_test', 'get', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('foo')
        done()
      })
    })

    it('should work without optional args', async () => {
      const { body: resp } = await fac._methodRequest('/method_request_test', 'get')
      expect(resp).to.be.equal('foo')
    })
  })

  describe('get tests', () => {
    before(() => {
      app.get('/get_test', (req, res) => {
        res.send('test')
      })
    })

    it('should perform requests as expected', async () => {
      const { body: resp } = await fac.get('/get_test', { method: 'post' })
      expect(resp).to.be.equal('test')
    })

    it('should support callbacks', (done) => {
      fac.get('/get_test', { method: 'post' }, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('test')
        done()
      })
    })

    it('should support callback as 2nd arg', (done) => {
      fac.get('/get_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('test')
        done()
      })
    })

    it('should work without optional args', async () => {
      const { body: resp } = await fac.get('/get_test')
      expect(resp).to.be.equal('test')
    })
  })

  describe('post tests', () => {
    let body = null
    const reqOpts = {
      method: 'get',
      body: 'foo=bar',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }

    before(() => {
      app.post('/post_test', express.urlencoded({ extended: true }), (req, res) => {
        body = req.body
        res.send('bar')
      })
    })

    afterEach(() => {
      body = null
    })

    it('should perform requests as expected', async () => {
      const { body: resp } = await fac.post('/post_test', reqOpts)
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({ foo: 'bar' })
    })

    it('should support callbacks', (done) => {
      fac.post('/post_test', reqOpts, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({ foo: 'bar' })
        done()
      })
    })

    it('should support callback as 2nd arg', (done) => {
      fac.post('/post_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({})
        done()
      })
    })

    it('should work without optional args', async () => {
      const { body: resp } = await fac.post('/post_test')
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({})
    })
  })

  describe('put tests', () => {
    let body = null
    const reqOpts = {
      method: 'get',
      body: 'foo=bar',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }

    before(() => {
      app.put('/put_test', express.urlencoded({ extended: true }), (req, res) => {
        body = req.body
        res.send('bar')
      })
    })

    afterEach(() => {
      body = null
    })

    it('should perform requests as expected', async () => {
      const { body: resp } = await fac.put('/put_test', reqOpts)
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({ foo: 'bar' })
    })

    it('should support callbacks', (done) => {
      fac.put('/put_test', reqOpts, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({ foo: 'bar' })
        done()
      })
    })

    it('should support callback as 2nd arg', (done) => {
      fac.put('/put_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({})
        done()
      })
    })

    it('should work without optional args', async () => {
      const { body: resp } = await fac.put('/put_test')
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({})
    })
  })

  describe('patch tests', () => {
    let body = null
    const reqOpts = {
      method: 'get',
      body: 'foo=bar',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }

    before(() => {
      app.patch('/patch_test', express.urlencoded({ extended: true }), (req, res) => {
        body = req.body
        res.send('bar')
      })
    })

    afterEach(() => {
      body = null
    })

    it('should perform requests as expected', async () => {
      const { body: resp } = await fac.patch('/patch_test', reqOpts)
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({ foo: 'bar' })
    })

    it('should support callbacks', (done) => {
      fac.patch('/patch_test', reqOpts, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({ foo: 'bar' })
        done()
      })
    })

    it('should support callback as 2nd arg', (done) => {
      fac.patch('/patch_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({})
        done()
      })
    })

    it('should work without optional args', async () => {
      const { body: resp } = await fac.patch('/patch_test')
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({})
    })
  })

  describe('delete tests', () => {
    let body = null
    const reqOpts = {
      method: 'get',
      body: 'foo=bar',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    }

    before(() => {
      app.delete('/delete_test', express.urlencoded({ extended: true }), (req, res) => {
        body = req.body
        res.send('bar')
      })
    })

    afterEach(() => {
      body = null
    })

    it('should perform requests as expected', async () => {
      const { body: resp } = await fac.delete('/delete_test', reqOpts)
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({ foo: 'bar' })
    })

    it('should support callbacks', (done) => {
      fac.delete('/delete_test', reqOpts, (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({ foo: 'bar' })
        done()
      })
    })

    it('should support callback as 2nd arg', (done) => {
      fac.delete('/delete_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.body).to.be.equal('bar')
        expect(body).to.be.deep.equal({})
        done()
      })
    })

    it('should work without optional args', async () => {
      const { body: resp } = await fac.delete('/delete_test')
      expect(resp).to.be.equal('bar')
      expect(body).to.be.deep.equal({})
    })
  })

  describe('head tests', () => {
    it('should perform requests as expected', async () => {
      const { headers } = await fac.head('/get_test', { headers: { foo: 'bar' } })
      expect(headers['content-type']).to.be.equal('text/html; charset=utf-8')
    })

    it('should support callbacks', (done) => {
      fac.head('/get_test', { headers: { foo: 'bar' } }, (err, res) => {
        expect(err).to.be.null()
        expect(res.headers['content-type']).to.be.equal('text/html; charset=utf-8')
        done()
      })
    })

    it('should support callback as 2nd arg', (done) => {
      fac.head('/get_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.headers['content-type']).to.be.equal('text/html; charset=utf-8')
        done()
      })
    })

    it('should work without optional args', async () => {
      const { headers } = await fac.head('/get_test')
      expect(headers['content-type']).to.be.equal('text/html; charset=utf-8')
    })
  })

  describe('options tests', () => {
    it('should perform requests as expected', async () => {
      const { headers } = await fac.options('/get_test', { headers: { foo: 'bar' } })
      expect(headers.allow).to.be.equal('GET,HEAD')
    })

    it('should support callbacks', (done) => {
      fac.options('/get_test', { headers: { foo: 'bar' } }, (err, res) => {
        expect(err).to.be.null()
        expect(res.headers.allow).to.be.equal('GET,HEAD')
        done()
      })
    })

    it('should support callback as 2nd arg', (done) => {
      fac.options('/get_test', (err, res) => {
        expect(err).to.be.null()
        expect(res.headers.allow).to.be.equal('GET,HEAD')
        done()
      })
    })

    it('should work without optional args', async () => {
      const { headers } = await fac.options('/get_test')
      expect(headers.allow).to.be.equal('GET,HEAD')
    })
  })
})
