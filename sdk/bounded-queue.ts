/**
 * FIFO queue with a maximum length. When full, the oldest item is dropped (head).
 */
export class BoundedQueue<T> {
  private readonly _items: T[] = [];

  constructor(private readonly _capacity: number) {
    if (!Number.isFinite(_capacity) || _capacity < 1) {
      throw new RangeError('BoundedQueue capacity must be >= 1');
    }
  }

  get capacity(): number {
    return this._capacity;
  }

  get length(): number {
    return this._items.length;
  }

  get isFull(): boolean {
    return this._items.length >= this._capacity;
  }

  /**
   * @returns true if an older item was dropped when enqueueing (buffer was full).
   */
  enqueue(item: T): boolean {
    const dropped = this._items.length >= this._capacity;
    if (dropped) {
      this._items.shift();
    }
    this._items.push(item);
    return dropped;
  }

  dequeue(): T | undefined {
    return this._items.shift();
  }
}
