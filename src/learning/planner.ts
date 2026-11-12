import {
	type ExecutionPlan,
	type InputBinding,
	learningResultSchema,
	type MemoryType,
	type PlannedNode,
	type PlanningLimits,
	type RecipeNode,
	type RevisionPins,
	type RootValue,
	schemaAccepts,
	type ValueSchema,
	type VersionRef,
} from './contracts'
import type { LearningRegistry } from './registry'

export interface PlanRecipeRequest {
	readonly recipe: VersionRef
	readonly roots: Readonly<Record<string, RootValue>>
	readonly memoryType: MemoryType
	readonly availableCapabilities: ReadonlySet<string>
	readonly revisions: RevisionPins
	readonly limits: PlanningLimits
}

function positiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`)
	}
}

function snapshot(value: unknown, seen = new WeakSet<object>()): unknown {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		typeof value === 'undefined'
	) {
		return value
	}
	if (typeof value === 'object' && value !== null) {
		if (seen.has(value))
			throw new Error('planned values must not contain cycles')
		seen.add(value)
	}
	if (Array.isArray(value)) {
		const copy = Object.freeze(value.map((entry) => snapshot(entry, seen)))
		seen.delete(value)
		return copy
	}
	if (typeof value !== 'object') {
		throw new Error('planned values must be portable data')
	}
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error('planned values must use plain objects')
	}
	const result = Object.create(null) as Record<string, unknown>
	for (const [key, entry] of Object.entries(value)) {
		Object.defineProperty(result, key, {
			value: snapshot(entry, seen),
			enumerable: true,
			writable: false,
			configurable: false,
		})
	}
	seen.delete(value)
	return Object.freeze(result)
}

function bindingKey(binding: InputBinding): string {
	return binding.source === 'root'
		? `root:${binding.root}`
		: `node:${binding.nodeId}:${binding.output}`
}

function nodeOutputSchema(node: PlannedNode, output: string): ValueSchema {
	const schema =
		node.kind === 'collection'
			? node.outputSchemas[output]
			: node.implementation.outputSchemas[output]
	if (schema === undefined) {
		throw new Error(`node ${node.id} has no output ${output}`)
	}
	return schema
}

function bindingSchema(
	binding: InputBinding,
	roots: Readonly<Record<string, RootValue>>,
	nodes: ReadonlyMap<string, PlannedNode>,
): ValueSchema {
	if (binding.source === 'root') {
		const root = roots[binding.root]
		if (root === undefined) throw new Error(`missing root ${binding.root}`)
		return root.schema
	}
	const producer = nodes.get(binding.nodeId)
	if (producer === undefined) {
		throw new Error(`missing producer node ${binding.nodeId}`)
	}
	return nodeOutputSchema(producer, binding.output)
}

function validateNodeInputs(
	node: PlannedNode,
	roots: Readonly<Record<string, RootValue>>,
	nodes: ReadonlyMap<string, PlannedNode>,
): void {
	const expectedInputs = Object.keys(node.implementation.inputSchemas)
	const suppliedInputs = Object.keys(node.inputs)
	if (node.kind === 'collection') suppliedInputs.push(node.itemInput)
	for (const name of expectedInputs) {
		if (!suppliedInputs.includes(name)) {
			throw new Error(`node ${node.id} is missing input ${name}`)
		}
	}
	for (const name of suppliedInputs) {
		if (!(name in node.implementation.inputSchemas)) {
			throw new Error(`node ${node.id} supplies unknown input ${name}`)
		}
	}
	for (const [name, binding] of Object.entries(node.inputs)) {
		const consumer = node.implementation.inputSchemas[name]
		if (consumer === undefined) continue
		const producer = bindingSchema(binding, roots, nodes)
		if (!schemaAccepts(consumer, producer)) {
			throw new Error(
				`incompatible binding ${bindingKey(binding)} for ${node.id}.${name}`,
			)
		}
	}
	if (node.kind !== 'collection') return
	const items = bindingSchema(node.items, roots, nodes)
	if (items.collectionItem === undefined) {
		throw new Error(`collection node ${node.id} requires a collection schema`)
	}
	const itemConsumer = node.implementation.inputSchemas[node.itemInput]
	if (
		itemConsumer === undefined ||
		!schemaAccepts(itemConsumer, items.collectionItem)
	) {
		throw new Error(`collection node ${node.id} has an incompatible item input`)
	}
	const operationOutputs = Object.keys(node.implementation.outputSchemas).sort()
	const aggregateOutputs = Object.keys(node.outputSchemas).sort()
	if (operationOutputs.join('\u0000') !== aggregateOutputs.join('\u0000')) {
		throw new Error(
			`collection node ${node.id} must aggregate every operation output`,
		)
	}
	for (const output of operationOutputs) {
		const aggregate = node.outputSchemas[output]
		const itemOutput = node.implementation.outputSchemas[output]
		if (
			aggregate?.collectionItem === undefined ||
			itemOutput === undefined ||
			!schemaAccepts(aggregate.collectionItem, itemOutput)
		) {
			throw new Error(
				`collection node ${node.id}.${output} has an incompatible aggregate schema`,
			)
		}
	}
}

function dependencies(node: RecipeNode): readonly string[] {
	const result = [...(node.after ?? [])]
	for (const binding of Object.values(node.inputs)) {
		if (binding.source === 'node') result.push(binding.nodeId)
	}
	if (node.kind === 'collection' && node.items.source === 'node') {
		result.push(node.items.nodeId)
	}
	return [...new Set(result)]
}

function validateDag(nodes: readonly PlannedNode[]): void {
	const byId = new Map(nodes.map((node) => [node.id, node]))
	const incoming = new Map(nodes.map((node) => [node.id, 0]))
	const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]))
	for (const node of nodes) {
		for (const predecessor of dependencies(node)) {
			if (!byId.has(predecessor)) {
				throw new Error(
					`node ${node.id} depends on missing node ${predecessor}`,
				)
			}
			if (predecessor === node.id) {
				throw new Error(`node ${node.id} cannot depend on itself`)
			}
			incoming.set(node.id, (incoming.get(node.id) ?? 0) + 1)
			outgoing.get(predecessor)?.push(node.id)
		}
	}
	const ready = [...incoming]
		.filter(([, count]) => count === 0)
		.map(([id]) => id)
	let visited = 0
	while (ready.length > 0) {
		const id = ready.pop()
		if (id === undefined) break
		visited += 1
		for (const next of outgoing.get(id) ?? []) {
			const count = (incoming.get(next) ?? 0) - 1
			incoming.set(next, count)
			if (count === 0) ready.push(next)
		}
	}
	if (visited !== nodes.length)
		throw new Error('recipe graph must not contain a cycle')
}

export function planRecipe(
	registry: LearningRegistry,
	request: PlanRecipeRequest,
): ExecutionPlan {
	positiveInteger(request.limits.maxNodes, 'maxNodes')
	positiveInteger(request.limits.maxCollectionItems, 'maxCollectionItems')
	positiveInteger(request.limits.maxOperations, 'maxOperations')
	const recipe = registry.getRecipe(request.recipe)
	if (recipe === undefined) {
		throw new Error(
			`missing recipe ${request.recipe.id}@${request.recipe.version}`,
		)
	}
	if (
		recipe.memoryTypes !== undefined &&
		!recipe.memoryTypes.includes(request.memoryType)
	) {
		throw new Error(`recipe does not support memory type ${request.memoryType}`)
	}
	if (recipe.nodes.length > request.limits.maxNodes) {
		throw new Error('recipe exceeds the node limit')
	}
	const ids = new Set<string>()
	let maximumOperations = 0
	const nodes = recipe.nodes.map((node): PlannedNode => {
		if (ids.has(node.id)) throw new Error(`duplicate node id ${node.id}`)
		ids.add(node.id)
		const implementation = registry.getOperation(node.operation)
		if (implementation === undefined) {
			throw new Error(
				`missing operation ${node.operation.id}@${node.operation.version}`,
			)
		}
		if (
			implementation.memoryTypes !== undefined &&
			!implementation.memoryTypes.includes(request.memoryType)
		) {
			throw new Error(
				`operation ${implementation.id} does not support ${request.memoryType}`,
			)
		}
		for (const capability of implementation.requiredCapabilities) {
			if (!request.availableCapabilities.has(capability)) {
				throw new Error(`missing capability ${capability} for node ${node.id}`)
			}
		}
		if (node.kind === 'collection') {
			positiveInteger(node.limit, `collection ${node.id} limit`)
			if (node.limit > request.limits.maxCollectionItems) {
				throw new Error(`collection ${node.id} exceeds its item limit`)
			}
			maximumOperations += node.limit
		} else {
			maximumOperations += 1
		}
		if (node.configuration !== undefined) {
			if (implementation.configurationSchema === undefined) {
				throw new Error(`node ${node.id} supplies unsupported configuration`)
			}
			implementation.configurationSchema.parse(node.configuration)
		} else if (implementation.configurationSchema !== undefined) {
			throw new Error(`node ${node.id} requires configuration`)
		}
		if (
			node.kind === 'gate' &&
			implementation.outputSchemas[node.appliesOutput] === undefined
		) {
			throw new Error(
				`gate ${node.id} has no applies output ${node.appliesOutput}`,
			)
		}
		return Object.freeze({
			...node,
			inputs: Object.freeze({ ...node.inputs }),
			...(node.after === undefined
				? {}
				: { after: Object.freeze([...node.after]) }),
			...(node.configuration === undefined
				? {}
				: { configuration: snapshot(node.configuration) }),
			implementation,
		})
	})
	if (maximumOperations > request.limits.maxOperations) {
		throw new Error('recipe exceeds the operation limit')
	}
	const byId = new Map(nodes.map((node) => [node.id, node]))
	const roots: Record<string, RootValue> = {}
	for (const [name, root] of Object.entries(request.roots)) {
		Object.freeze(root.schema)
		roots[name] = Object.freeze({
			schema: root.schema,
			value: snapshot(root.schema.parse(root.value)),
		})
	}
	for (const node of nodes) validateNodeInputs(node, roots, byId)
	validateDag(nodes)
	const resultSchema = bindingSchema(recipe.result, roots, byId)
	if (!schemaAccepts(learningResultSchema, resultSchema)) {
		throw new Error('recipe result must use the learning result schema')
	}
	return Object.freeze({
		recipe: Object.freeze({ id: recipe.id, version: recipe.version }),
		memoryType: request.memoryType,
		revisions: Object.freeze({ ...request.revisions }),
		roots: Object.freeze(roots),
		nodes: Object.freeze(nodes),
		result: Object.freeze({ ...recipe.result }),
	})
}

export function operationKey(reference: VersionRef): string {
	return `${reference.id}@${reference.version}`
}

export function nodeDependencies(node: PlannedNode): readonly string[] {
	return dependencies(node)
}

export function requiredNodeDependencies(node: PlannedNode): readonly string[] {
	const required = [...(node.after ?? [])]
	for (const binding of Object.values(node.inputs)) {
		if (binding.source === 'node' && binding.optional !== true)
			required.push(binding.nodeId)
	}
	if (
		node.kind === 'collection' &&
		node.items.source === 'node' &&
		node.items.optional !== true
	) {
		required.push(node.items.nodeId)
	}
	return [...new Set(required)]
}
