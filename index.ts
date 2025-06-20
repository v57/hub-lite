import { Channel, type Sender, ObjectMap } from 'channel/server'
import { LazyState } from 'channel/more'
const paddr = (a?: string) => (a ? (isNaN(Number(a)) ? a : Number(a)) : 1997)

interface State {
  services: string[]
  requests: number
}
let requests = 0
export class Hub {
  services = new ObjectMap<string, Services>()
  channel = new Channel<State>()
  constructor(address = paddr(Bun.env.HUBLISTEN)) {
    const statusState = new LazyState(() => ({
      requests,
      services: this.services.map(a => a.status),
    }))
    const statusBadges = new LazyState<StatusBadges>(() => this.statusBadges)
    this.channel
      .post('hub/service/update', ({ body: { add, remove }, sender }) => {
        if (add && Array.isArray(add)) this.addServices(sender, add)
        if (remove && Array.isArray(remove)) this.removeServices(sender, remove)
        statusState.setNeedsUpdate()
        statusBadges.setNeedsUpdate()
      })
      .stream('hub/status', () => statusState.makeIterator())
      .stream('hub/status/badges', () => statusBadges.makeIterator())
      .postOther(other, async ({ body }, path) => {
        const service = this.services.get(path)
        if (!service) throw 'api not found'
        const sender = service.next()
        if (!sender) throw 'api not found'
        service.requests += 1
        statusState.setNeedsUpdate()
        return await sender.send(path, body)
      })
      .streamOther(other, ({ body }, path) => {
        const service = this.services.get(path)
        if (!service) throw 'api not found'
        const sender = service.next()
        if (!sender) throw 'api not found'
        service.requests += 1
        requests += 1
        statusState.setNeedsUpdate()
        return sender.values(path, body)
      })
      .onDisconnect((state, sender) => {
        state.services.forEach(s => this.services.get(s)?.remove(sender))
        statusState.setNeedsUpdate()
      })
      .listen(address, {
        state: () => ({
          services: [],
          requests: 0,
        }),
      })
  }
  stats() {
    this.services.map(a => a)
  }
  addServices(sender: Sender, services: string[]) {
    services.forEach(s => {
      let service = this.services.get(s)
      if (!service) {
        service = new Services(s)
        this.services.set(s, service)
      }
      service.add(sender)
      console.log('Service', s, service.services.length)
    })
  }
  removeServices(sender: Sender, services: string[]) {
    services.forEach(s => {
      let service = this.services.get(s)
      if (!service) return
      service.remove(sender)
    })
  }
  get statusBadges(): StatusBadges {
    return { services: this.services.size }
  }
}

function other(): boolean {
  return true
}

class Services {
  name: string
  requests = 0
  services: Sender[] = []
  index = 0
  constructor(name: string) {
    this.name = name
  }
  add(sender: Sender) {
    this.services.push(sender)
  }
  remove(sender: Sender) {
    const index = this.services.findIndex(a => a === sender)
    if (index >= 0) this.services.splice(index, 1)
  }
  next() {
    if (!this.services.length) return
    const id = this.index++ % this.services.length
    return this.services.at(id)
  }
  get status() {
    return { name: this.name, services: this.services.length, requests: this.requests }
  }
}

interface StatusBadges {
  services: number
}
