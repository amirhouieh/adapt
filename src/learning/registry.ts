import type { Operation, Recipe, VersionRef } from './contracts'

function key(reference: VersionRef): string {
	return JSON.stringify([reference.id, reference.version])
}

function label(reference: VersionRef): string {
	return `${reference.id}@${reference.version}`
}

function snapshot(value: unknown, seen = new WeakSet<object>()): unknown {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		typeof value === 'undefined'
	)
		return value
	if (typeof value !== 'object')
		throw new Error('recipe configuration must be portable data')
	if (seen.has(value))
		throw new Error('recipe configuration must not contain cycles')
	seen.add(value)
	if (Array.isArray(value)) {
		const copy = Object.freeze(value.map((entry) => snapshot(entry, seen)))
		seen.delete(value)
		return copy
	}
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error('recipe configuration must use plain objects')
	}
	const result = Object.create(null) as Record<string, unknown>
	for (const [property, entry] of Object.entries(value)) {
		Object.defineProperty(result, property, {
			value: snapshot(entry, seen),
			enumerable: true,
			writable: false,
			configurable: false,
		})
	}
	seen.delete(value)
	return Object.freeze(result)
}

function freezeOperation(operation: Operation): Operation {
	for (const schema of Object.values(operation.inputSchemas))
		Object.freeze(schema)
	for (const schema of Object.values(operation.outputSchemas))
		Object.freeze(schema)
	return Object.freeze({
		...operation,
		inputSchemas: Object.freeze({ ...operation.inputSchemas }),
		outputSchemas: Object.freeze({ ...operation.outputSchemas }),
		requiredCapabilities: Object.freeze([...operation.requiredCapabilities]),
		...(operation.memoryTypes === undefined
			? {}
			: { memoryTypes: Object.freeze([...operation.memoryTypes]) }),
	})
}

function freezeRecipe(recipe: Recipe): Recipe {
	const nodes = recipe.nodes.map((node) =>
		Object.freeze({
			...node,
			operation: Object.freeze({ ...node.operation }),
			inputs: Object.freeze(
				Object.fromEntries(
					Object.entries(node.inputs).map(([name, binding]) => [
						name,
						Object.freeze({ ...binding }),
					]),
				),
			),
			...(node.after === undefined
				? {}
				: { after: Object.freeze([...node.after]) }),
			...(node.configuration === undefined
				? {}
				: { configuration: snapshot(node.configuration) }),
			...(node.kind === 'collection'
				? {
						items: Object.freeze({ ...node.items }),
						outputSchemas: Object.freeze({ ...node.outputSchemas }),
					}
				: {}),
		}),
	)
	return Object.freeze({
		...recipe,
		nodes: Object.freeze(nodes),
		result: Object.freeze({ ...recipe.result }),
		...(recipe.memoryTypes === undefined
			? {}
			: { memoryTypes: Object.freeze([...recipe.memoryTypes]) }),
	})
}

export class LearningRegistry {
	readonly #operations = new Map<string, Operation>()
	readonly #recipes = new Map<string, Recipe>()

	registerOperation(operation: Operation): VersionRef {
		const operationKey = key(operation)
		if (this.#operations.has(operationKey)) {
			throw new Error(`operation version ${label(operation)} is immutable`)
		}
		this.#operations.set(operationKey, freezeOperation(operation))
		return Object.freeze({ id: operation.id, version: operation.version })
	}

	registerRecipe(recipe: Recipe): VersionRef {
		const recipeKey = key(recipe)
		if (this.#recipes.has(recipeKey)) {
			throw new Error(`recipe version ${label(recipe)} is immutable`)
		}
		this.#recipes.set(recipeKey, freezeRecipe(recipe))
		return Object.freeze({ id: recipe.id, version: recipe.version })
	}

	getOperation(reference: VersionRef): Operation | undefined {
		return this.#operations.get(key(reference))
	}

	getRecipe(reference: VersionRef): Recipe | undefined {
		return this.#recipes.get(key(reference))
	}
}
