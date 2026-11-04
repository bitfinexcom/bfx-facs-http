'use strict'

const http = require('http')
const https = require('https')
const { readFileSync } = require('fs')
const { join } = require('path')

const text = readFileSync(join(__dirname, 'response.txt'), 'utf8')

module.exports = async function createFixture () {
  const handler = (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    if (pathname === '/redirect') {
      res.writeHead(301, { location: '/' })
    } else if (pathname === '/headers') {
      res.writeHead(200, { 'content-type': 'application/json', allow: 'GET, HEAD, OPTIONS' })
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' })
    }
    res.end(text)
  }
  const servers = [http.createServer(handler), https.createServer({
    key: readFileSync(join(__dirname, 'key.pem')),
    cert: readFileSync(join(__dirname, 'cert.pem'))
  }, handler)]
  const stop = () => Promise.all(servers.map(server => new Promise((resolve, reject) => {
    if (!server.listening) return resolve()
    server.close(err => err ? reject(err) : resolve())
    server.closeAllConnections()
  })))
  try {
    for (const server of servers) {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
    }
  } catch (err) {
    await stop()
    throw err
  }
  return {
    text,
    httpUrl: `http://localhost:${servers[0].address().port}`,
    httpsUrl: `https://localhost:${servers[1].address().port}`,
    stop
  }
}
