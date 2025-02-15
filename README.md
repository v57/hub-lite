# Usage

## Start hub process

```ts
import { Hub } from 'hub-lite'
new Hub()
```

## Create hub service

```ts
import { Service } from 'hub-service'
new Service().post('hash/sha256', body => new Bun.SHA256().update(body).digest('hex')).start()
```

## Client api

```ts
import { Client } from 'hub-client'
const client = new Client()
const hash = await client.post('hash/sha256', 'Hello World')
console.log(hash)
```

# Security

Hub lite doesn't have any built in security

- Designed to run on isolated servers
- Always listens to 127.0.0.1
- Anyone who has access to Hub port can make a service
- There is no authorization
