# bfx-facs-http

A facility that simplifies making http requests both on promise and callback approaches.

## Config

Fac doesn't support config files but supports the options defined below:
- `baseUrl<String?>` - Optional base url
- `timeout<Number?>` - Optional request timeout, default one is node default timeout (0)
- `debug<(Boolean|Number)?>` - Optional debug flag, default false
- `qs<(String|Array<String>|Object)?>` - Optional, default query string params 

## API

### fac.request

Performs generic HTTP request

Params:
  - `path<String>` - Full request url or path
  - `opts<Object?>` - Optional request options
    - `body<(String|Object)?>` - Optional request body, in case of json encoding it can be also object
    - `headers<Object<String, String>?>` Optional request headers
    - `method<String?>` - Optional http method, currently supported `get`, `head`, `post`, `put`, `patch`,
                         `delete`, `options`. Default value is `get`
    - `redirect<Boolean?>` - Optional, follow redirects or treat them as errors, default is treat as error
    - `auth<Object?>` - HTTP Basic authorization credentials. Overwrites header `authorization`. Please note
                        only HTTP Basic auth is configurable through this parameter.
      - `username<String?>`
      - `password<String?>`
    - `agent<http.Agent?>` - Optional user agent
    - `compress<Boolean?>` - Optional, support gzip/deflate content encoding
    - `timeout<Number?>` - Optional request timeout, default is opt provided in fac setup (3s)
    - `encoding<(String|Object)?>` - Optional request and response encoding,
                                     if string is provided it applies to both request and response.
                                     Default encoding is text for both request and response
      - `req<String?>` - Optional request body encoding, supported: `json` and `text`. 
                         If no value is provided it will be treated as text
      - `res<String?>` - Optional response body encoding, supported: `json`, `text` and `raw`. 
                         If no value is provided it will be treated as text,
                         if unsupported value is provided it will return buffer.
                         If value is `raw` then body stream is returned, useful for file downloads
    - `qs<(String|Array<String>|Object)?>` - Optional, query string params 
  - `cb<Function?>` - Optional callback function, if not provided call will be treated as promise

Response:
  - `Promise<{ body: any, headers: object }>|void` - Server response, promise or callback result

Examples:
```js
// GET
const { body, headers } = await fac.request('https://example.com')

// POST
const { body, headers } = await fac.request('https://example.com/submit', { method: 'post', body: { foo: 'bar' }, encoding: 'json' })

// OPTIONS
const { headers } = await fac.request('https://api-pub.bitfinex.com/v2/conf/pub:list:currency', { method: 'options' })

// Callback
fac.request(
  '/data/store',
  { method: 'patch', body: 'test=33&foo=bar', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
  (err, resp) => {
    ...
  })

// Request without options
fac.request('/data', (err, resp) => {
  ...
})

// error handling
fac.request('/data/store', (err) => {
  console.log(err.message) // ERR_HTTP: 500 - Internal Server Error
  console.log(err.status) // 500
  console.log(err.statusText) // Internal Server Error
  console.log(err.response) // { auth: 'failed' }
})

// file download
const eos = require('end-of-stream')

const { body: resp } = await fac.request('/file', { encoding: { res: 'raw' } }) // raw means return stream
await new Promise((resolve, reject) => {
  const writer = fs.createWriteStream(writefile)
  eos(writer, (err) => err ? reject(err) : resolve())
  resp.pipe(writer)
})
```

### fac.get

Performs HTTP GET request

Params:
- Same as in request method just without `method` param

Response:
- Same as in request method

Example:
```js
await fac.get('https://api-pub.bitfinex.com/v2/conf/pub:list:currency')
```

### fac.post

Performs HTTP POST request

Params:
- Same as in request method just without `method` param

Response:
- Same as in request method

Example:
```js
const FormData = require('form-data')

const form = new FormData();
form.append('a', 1);

const reqOpts = {
  body: form,
  headers: form.getHeaders()
}

await fac.post('/submit', reqOpts)
```

### fac.put

Performs HTTP PUT request

Params:
- Same as in request method just without `method` param

Response:
- Same as in request method

Example:
```js
const reqOpts = {
  body: JSON.stringify({ a: 1 }),
  headers: {
    'Content-Type': 'application/json'
  }
}

await fac.put('/data/store', reqOpts)
```

### fac.patch

Performs HTTP PATCH request

Params:
- Same as in request method just without `method` param

Response:
- Same as in request method

Example:
```js
const reqOpts = {
  body: { a: 1 },
  encoding: 'json'
}

await fac.patch('/data/store', reqOpts)
```

### fac.delete

Performs HTTP DELETE request

Params:
- Same as in request method just without `method` param

Response:
- Same as in request method

Example:
```js
const reqOpts = {
  body: JSON.stringify({ id: 31 }),
  headers: {
    'Content-Type': 'application/json'
  }
}

await fac.delete('/books', reqOpts)
```

### fac.head

Performs HTTP HEAD request

Params:
- Same as in request method just without `method` param

Response:
- HTTP response headers

Example:
```js
const { headers } = await fac.head('https://api-pub.bitfinex.com/v2/conf/pub:list:currency')
console.log(headers['content-type']) // 'application/json; charset=utf-8'
```

### fac.options

Performs HTTP OPTIONS request

Params:
- Same as in request method just without `method` param

Response:
- HTTP response headers

Example:
```js
const { headers } = await fac.head('https://api-pub.bitfinex.com/v2/conf/pub:list:currency')
console.log(headers['allow']) // 'GET,PUT,POST'
```
