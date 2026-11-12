export type DevicePriority = 'query' | 'foreground' | 'background'

export type DeviceSchedulerRunOptions = {
	priority: DevicePriority
	signal?: AbortSignal
}

export interface DeviceScheduler {
	run<Result>(
		call: () => Promise<Result>,
		options: DeviceSchedulerRunOptions,
	): Promise<Result>
}

export type BoundedDeviceSchedulerConfig = {
	maxConcurrent: number
	maxQueued: number
}

export class DeviceQueueFullError extends Error {
	constructor(readonly maxQueued: number) {
		super(`Local model queue is full (maximum waiting calls: ${maxQueued})`)
		this.name = 'DeviceQueueFullError'
	}
}

type QueueEntry = {
	priority: DevicePriority
	sequence: number
	accept: () => void
	reject: (reason: unknown) => void
	signal?: AbortSignal
	abort: () => void
}

const priorityOrder: Record<DevicePriority, number> = {
	query: 0,
	foreground: 1,
	background: 2,
}

/**
 * One bounded queue for all physical calls to a local device.
 *
 * Adapted from Thro's `BoundedProviderScheduler` at
 * 07b4545d9397463f4e86d4a8c454c22c39022cd8. Adapt adds a queue bound and
 * stable query/foreground/background priority ordering.
 */
export class BoundedDeviceScheduler implements DeviceScheduler {
	readonly #config: BoundedDeviceSchedulerConfig
	readonly #queue: QueueEntry[] = []
	#active = 0
	#sequence = 0

	constructor(config: BoundedDeviceSchedulerConfig) {
		if (!Number.isInteger(config.maxConcurrent) || config.maxConcurrent < 1) {
			throw new Error('maxConcurrent must be a positive integer')
		}
		if (!Number.isInteger(config.maxQueued) || config.maxQueued < 0) {
			throw new Error('maxQueued must be a nonnegative integer')
		}
		this.#config = Object.freeze({
			maxConcurrent: config.maxConcurrent,
			maxQueued: config.maxQueued,
		})
	}

	async run<Result>(
		call: () => Promise<Result>,
		options: DeviceSchedulerRunOptions,
	): Promise<Result> {
		options.signal?.throwIfAborted()
		if (
			this.#active >= this.#config.maxConcurrent &&
			this.#queue.length >= this.#config.maxQueued
		) {
			throw new DeviceQueueFullError(this.#config.maxQueued)
		}

		await new Promise<void>((accept, reject) => {
			const entry: QueueEntry = {
				priority: options.priority,
				sequence: this.#sequence,
				accept,
				reject,
				signal: options.signal,
				abort: () => {
					const index = this.#queue.indexOf(entry)
					if (index >= 0) this.#queue.splice(index, 1)
					reject(
						options.signal?.reason ??
							new DOMException('The request was aborted', 'AbortError'),
					)
				},
			}
			this.#sequence += 1
			options.signal?.addEventListener('abort', entry.abort, { once: true })
			this.#queue.push(entry)
			this.#drain()
		})

		try {
			options.signal?.throwIfAborted()
			return await call()
		} finally {
			this.#active -= 1
			this.#drain()
		}
	}

	#drain(): void {
		while (
			this.#active < this.#config.maxConcurrent &&
			this.#queue.length > 0
		) {
			this.#queue.sort(
				(left, right) =>
					priorityOrder[left.priority] - priorityOrder[right.priority] ||
					left.sequence - right.sequence,
			)
			const entry = this.#queue.shift()
			if (!entry) continue
			entry.signal?.removeEventListener('abort', entry.abort)
			if (entry.signal?.aborted) {
				entry.reject(entry.signal.reason)
				continue
			}
			this.#active += 1
			entry.accept()
		}
	}
}

export function createBoundedDeviceScheduler(
	config: BoundedDeviceSchedulerConfig,
): DeviceScheduler {
	return new BoundedDeviceScheduler(config)
}
