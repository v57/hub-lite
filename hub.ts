import { Channel, type Sender, ObjectMap } from 'channel/server'
import { LazyState, LazyStates } from 'channel/more'
import type { Cancellable } from 'channel/channel'
const paddr = (a?: string) => (a ? (isNaN(Number(a)) ? a : Number(a)) : 1997)

interface State {
  id: string
  services: Set<string>
  apps: Set<string>
  name?: string
  icon?: any
}
let requests = 0
export class Hub {
  services = new ObjectMap<string, Services>()
  channel = new Channel<State>()
  apps = new Apps()
  api = new Set<string>()
  apiList = new LazyStates<State, string[]>(() => Array.from(this.api))
  constructor(address = paddr(Bun.env.HUBLISTEN)) {
    const services = this.services
    const statusState = new LazyState(() => ({
      requests,
      services: this.services.map(a => a.status),
    }))
    const statusBadges = new LazyState<StatusBadges>(() => this.statusBadges)
    const sendUpdates = () => {
      statusState.setNeedsUpdate()
      statusBadges.setNeedsUpdate()
    }
    this.channel
      .post('hub/api', () => Array.from(this.api))
      .stream('hub/api', ({ state }) => this.apiList.makeIterator(state))
      .post('hub/profile/update', ({ body: { name, icon }, state }) => {
        if (icon) state.icon = icon
        if (name) state.name = name
      })
      .post('hub/service/update', ({ body: { add, remove, addApps, removeApps, services, apps }, sender, state }) => {
        const context = new ServiceUpdateContext(this)
        if (services && Array.isArray(services)) {
          const s = services as ServiceHeader[]
          const paths = new Set(s.map(a => a.path))
          const add = paths.difference(state.services)
          const remove = state.services.difference(paths)
          this.addServices(sender, state, Array.from(add), context)
          this.removeServices(sender, state, Array.from(remove), context)
        }
        if (apps && Array.isArray(apps)) {
          const paths = new Set((apps as AppHeader[]).map(a => a.path))
          const add = paths.difference(state.apps)
          const remove = state.apps.difference(paths)
          const newApps = (apps as AppHeader[]).filter(app => add.has(app.path))
          this.apps.add(sender, state, newApps)
          this.apps.remove(sender, state, Array.from(remove))
        }
        if (add && Array.isArray(add)) this.addServices(sender, state, add, context)
        if (remove && Array.isArray(remove)) this.removeServices(sender, state, remove, context)
        if (addApps && Array.isArray(addApps)) this.apps.add(sender, state, addApps)
        if (removeApps && Array.isArray(removeApps)) this.apps.remove(sender, state, removeApps)
        context.applyChanges()
        sendUpdates()
      })
      .stream('hub/status', () => statusState.makeIterator())
      .stream('hub/status/badges', () => statusBadges.makeIterator())
      .postOther(other, async ({ body, path, task }) => {
        const service = this.services.get(path)
        if (!service) throw 'api not found'
        const s = await service.next()
        if (!s) throw 'api not found'
        if (task?.isCancelled) throw 'cancelled'
        service.requests += 1
        requests += 1
        statusState.setNeedsUpdate()
        const request = s.sender.request(path, body)
        try {
          if (task) s.sending.add(task)
          task?.onCancel(request.cancel)
          return await request.response
        } finally {
          if (task) s.sending.delete(task)
          service.completed(s)
        }
      })
      .streamOther(other, async function* ({ body, path }) {
        const service = services.get(path)
        if (!service) throw 'api not found'
        const s = await service.next()
        if (!s) throw 'api not found'
        service.requests += 1
        requests += 1
        s.streams += 1
        statusState.setNeedsUpdate()
        try {
          for await (const value of s.sender.values(path, body)) {
            yield value
          }
        } finally {
          s.streams -= 1
          service.completed(s)
        }
      })
      .onDisconnect((state, sender) => {
        const context = new ServiceUpdateContext(this)
        this.removeServices(sender, state, Array.from(state.services), context)
        const sendUpdates = state.apps.size > 0
        this.apps.removeSender(sender, state)
        context.applyChanges()
        statusState.setNeedsUpdate()
        if (sendUpdates) statusBadges.setNeedsUpdate()
      })
      .listen(address, {
        state: () => ({
          id: Bun.randomUUIDv7(),
          services: new Set<string>(),
          apps: new Set<string>(),
        }),
      })
    this.api = new Set([...Object.keys(this.channel.postApi.storage), ...Object.keys(this.channel.streamApi.storage)])
  }
  stats() {
    this.services.map(a => a)
  }
  addServices(sender: Sender, state: State, services: string[], context: ServiceUpdateContext) {
    services.forEach(s => {
      if (state.services.has(s)) return
      state.services.add(s)
      let service = this.services.get(s)
      if (!service) {
        service = new Services(s)
        this.services.set(s, service)
      }
      service.add({ sender, state, sending: new Set(), streams: 0 }, context)
    })
  }
  removeServices(sender: Sender, state: State, services: string[], context: ServiceUpdateContext) {
    services.forEach(s => {
      if (!state.services.has(s)) return
      state.services.delete(s)
      let service = this.services.get(s)
      if (!service) return
      service.remove(sender, context)
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
      header.services = 1
      this.headers.push(header)
    } else {
      const i = this.headers.findIndex(h => h.path === header.path)
      if (i !== -1) this.headers[i].services = (this.headers[i].services ?? 0) + 1
      state.senders.add(sender)
    }
  }
  removeSender(sender: Sender, senderState: State) {
    senderState.apps.forEach(path => {
      this.removeOne(sender, path)
    })
    senderState.apps = new Set()
  }
  remove(sender: Sender, senderState: State, paths: string[]) {
    for (const path of paths) {
      if (!senderState.apps.has(path)) continue
      senderState.apps.delete(path)
      this.removeOne(sender, path)
    }
  }
  removeOne(sender: Sender, path: string) {
    let state: AppState | undefined = this.states.get(path)
    if (!state) return
    state.senders.delete(sender)
    const i = this.headers.findIndex(h => h.path === path)
    if (i !== -1) this.headers[i].services = Math.max((this.headers[i].services ?? 0) - 1, 0)
  }
}
interface AppState {
  senders: Set<Sender>
  header: AppHeader
}

function other(): boolean {
  return true
}

export interface Service {
  state: State
  sender: Sender
  sending: Set<Cancellable>
  streams: number
}
class Services {
  name: string
  requests = 0
  services: Service[] = []
  pending: ((service: Service | undefined) => void)[] = []
  isEnabled = false
  index = 0
  constructor(name: string) {
    this.name = name
  }
  add(service: Service, context: ServiceUpdateContext) {
    if (this.services.findIndex(a => a.sender === service.sender) === -1) {
      this.services.push(service)
      this.enableServiceIfNeeded(context)
      if (this.pending.length) this.pending.shift()?.(service)
    }
  }
  remove(sender: Sender, context: ServiceUpdateContext) {
    const index = this.services.findIndex(a => a.sender === sender)
    if (index >= 0) {
      const s = this.services[index]
      s.sending.forEach(a => a.cancel())
      this.services.splice(index, 1)
    }
    this.disableServiceIfNeeded(context)
  }
  private enableServiceIfNeeded(context: ServiceUpdateContext) {
    if (this.isEnabled || !this.services.length) return
    this.isEnabled = true
    context.add(this.name)
  }
  private disableServiceIfNeeded(context: ServiceUpdateContext) {
    if (!this.isEnabled || this.services.length) return
    this.isEnabled = false
    context.remove(this.name)
    if (this.pending.length) {
      this.pending.forEach(a => a(undefined))
      this.pending = []
    }
  }
  _next() {
    if (!this.services.length) return
    const id = this.index++ % this.services.length
    return this.services.at(id)
  }
  async next(): Promise<Service | undefined> {
    if (this.pending.length > 0) return this.addPending()
    const service = this._next()
    if (service) return service
    return this.addPending()
  }
  private addPending(): Promise<Service | undefined> {
    return new Promise(success => this.pending.push(service => success(service)))
  }
  get status(): ServicesStatus {
    return {
      name: this.name,
      services: this.services.length,
      requests: this.requests,
      pending: this.pending.length,
      running: this.services.reduce((a, b) => a + b.sending.size + b.streams, 0),
    }
  }
  completed(service: Service) {
    if (service.sending.size > 0 || this.pending.length === 0) return
    this.pending.shift()?.(service)
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
  services?: number
}

interface ConnectionInfo {
  id?: string
  services?: number
  apps?: number
}

interface ServiceHeader {
  path: string
}

export class ServiceUpdateContext {
  hub: Hub
  hasChanges = false
  constructor(hub: Hub) {
    this.hub = hub
  }
  add(service: string) {
    console.log('+', service)
    this.hasChanges = true
    this.hub.api.add(service)
  }
  remove(service: string) {
    console.log('-', service)
    this.hasChanges = true
    this.hub.api.delete(service)
  }
  applyChanges() {
    if (!this.hasChanges) return
    this.hub.apiList.setNeedsUpdate()
  }
}

interface ServicesStatus {
  name: string
  requests: number
  services: number
  pending: number
  running: number
}
