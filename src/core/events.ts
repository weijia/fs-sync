// Minimal typed event emitter.

export type Listener<T> = (payload: T) => void;

export class Emitter<Events> {
  private map: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, cb: Listener<Events[K]>): () => void {
    (this.map[event] ??= new Set<Listener<Events[K]>>()).add(cb);
    return () => this.off(event, cb);
  }

  off<K extends keyof Events>(event: K, cb: Listener<Events[K]>): void {
    this.map[event]?.delete(cb);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.map[event]?.forEach((cb) => cb(payload));
  }
}
