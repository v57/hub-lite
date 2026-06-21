<h1>
  <img alt="Containerization logo" src="./icon.png" width="70" valign="middle">
  &nbsp;Hub Lite Server
</h1>

`hub-lite` is a main server for your Hub network

## Quick Start
#### [Run from Hub cli](https://github.com/v57/hub)

#### Run from Bun
```sh
bunx v57/hub-lite
```
#### Run from Source
```sh
bun i && bun .
```

## Environment
- `HUBLISTEN`: default listen address or port.

## Create hub service
[TypeScript](https://github.com/v57/hub-service) [Swift](https://github.com/v57/HubService)

```ts
import { Service } from 'hub-service'
new Service().post('hash/sha256', body => new Bun.SHA256().update(body).digest('hex')).start()
```

## Client api

```ts
import { Service } from 'hub-service'
const service = new Service().start()
const hash = await service.send('hash/sha256', 'Hello World')
console.log(hash)
```
