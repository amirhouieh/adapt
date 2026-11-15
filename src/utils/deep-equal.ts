/**
 * Structural equality for plain data (JSON-like values: primitives, arrays,
 * plain objects). Key order does not matter; a key set to `undefined` is not
 * the same as a missing key. Used instead of `node:util` `isDeepStrictEqual`
 * so the library runs in browsers and edge runtimes.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true
	if (typeof left !== 'object' || typeof right !== 'object') return false
	if (left === null || right === null) return false
	if (Array.isArray(left) !== Array.isArray(right)) return false
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length &&
			left.every((value, index) => deepEqual(value, right[index]))
		)
	}
	const a = left as Record<string, unknown>
	const b = right as Record<string, unknown>
	const keys = Object.keys(a)
	if (keys.length !== Object.keys(b).length) return false
	return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
}
