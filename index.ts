import { Channel, type Sender, ObjectMap } from 'channel/server'
import { LazyState } from 'channel/more'
const paddr = (a?: string) => (a ? (isNaN(Number(a)) ? a : Number(a)) : 1997)

interface State {
  services: Set<string>
  apps: Set<string>
  requests: number
}
let requests = 0
export class Hub {
  services = new ObjectMap<string, Services>()
  channel = new Channel<State>()
  apps = new Apps()
  constructor(address = paddr(Bun.env.HUBLISTEN)) {
    const statusState = new LazyState(() => ({
      requests,
      services: this.services.map(a => a.status),
    }))
    const statusBadges = new LazyState<StatusBadges>(() => this.statusBadges)
    this.channel
      .post('hub/service/update', ({ body: { add, remove, addApps }, sender, state }) => {
        if (add && Array.isArray(add)) this.addServices(sender, state, add)
        if (remove && Array.isArray(remove)) this.removeServices(sender, state, remove)
        if (addApps && Array.isArray(addApps)) this.apps.add(sender, state, addApps)
        statusState.setNeedsUpdate()
        statusBadges.setNeedsUpdate()
      })
      .post('hub/permissions', () => [])
      .stream('hub/status', () => statusState.makeIterator())
      .stream('hub/status/badges', () => statusBadges.makeIterator())
      .postOther(other, async ({ body, path }) => {
        const service = this.services.get(path)
        if (!service) throw 'api not found'
        const sender = service.next()
        if (!sender) throw 'api not found'
        service.requests += 1
        statusState.setNeedsUpdate()
        return await sender.send(path, body)
      })
      .streamOther(other, ({ body, path }) => {
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
          services: new Set<string>(),
          requests: 0,
          apps: new Set<string>(),
        }),
      })
  }
  stats() {
    this.services.map(a => a)
  }
  addServices(sender: Sender, state: State, services: string[]) {
    state.services
    services.forEach(s => {
      if (state.services.has(s)) return
      state.services.add(s)
      let service = this.services.get(s)
      if (!service) {
        service = new Services(s)
        this.services.set(s, service)
      }
      service.add(sender)
      console.log('Service', s, service.services.length)
    })
  }
  removeServices(sender: Sender, state: State, services: string[]) {
    services.forEach(s => {
      if (!state.services.has(s)) return
      state.services.delete(s)
      let service = this.services.get(s)
      if (!service) return
      service.remove(sender)
    })
  }
  get statusBadges(): StatusBadges {
    return { services: this.services.size, apps: this.apps.headers }
  }
}

class Apps {
  states = new ObjectMap<string, AppState>()
  headers: AppHeader[] = []
  add(sender: Sender, senderState: State, headers: AppHeader[]) {
    headers.forEach(header => {
      this.addOne(sender, senderState, header)
    })
  }
  addOne(sender: Sender, senderState: State, header: AppHeader) {
    if (senderState.apps.has(header.path)) return
    senderState.apps.add(header.path)
    let state: AppState | undefined = this.states.get(header.path)
    if (!state) {
      state = { senders: new Set([sender]), header }
      this.states.set(header.path, state)
      this.headers.push(header)
    } else {
      state.senders.add(sender)
    }
  }
}
interface AppState {
  senders: Set<Sender>
  header: AppHeader
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
  apps: AppHeader[]
}

interface AppHeader {
  type: 'app'
  name: string
  path: string
}
interface AppHeaderInfo {
  services: number
  header: AppHeader
}
