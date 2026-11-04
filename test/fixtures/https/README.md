# Local HTTPS fixture

The certificate and private key are public test data for loopback servers only.
The certificate covers localhost and 127.0.0.1 and expires in November 2036.
`npm run unit` trusts this certificate through `NODE_EXTRA_CA_CERTS`; TLS
certificate verification remains enabled. No production code uses these files.

Regenerate from the repository root when necessary:

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout test/fixtures/https/key.pem -out test/fixtures/https/cert.pem \
  -days 3650 -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```
