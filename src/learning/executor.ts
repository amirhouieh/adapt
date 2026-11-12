import {
	learningResultSchema,
	type BudgetController,
	type CapabilityResolver,
	type ExecutionPlan,
	type InputBinding,
	type LearningResult,
	type NodeExecution,
	type PendingCollection,
	type PlannedNode,
	type RecipeExecution,
} from './contracts'
import { nodeDependencies, requiredNodeDependencies } from './planner'

export interface RunRecipeDependencies {
	readonly capabilities: CapabilityResolver
	readonly budget: BudgetController
	readonly signal: AbortSignal
}

type NodeState = NodeExecution & {
	readonly outputs?: Readonly<Record<string, unknown>>
}

function failure(code: string, reason: string, retryable: boolean): LearningResult {
	return { outcome: 'failure', code, reason, retryable }
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'operation failed with a non-Error value'
}

function resolveBinding(
	binding: InputBinding,
	plan: ExecutionPlan,
	states: ReadonlyMap<string, NodeState>,
): unknown {
	if (binding.source === 'root') {
		const root = plan.roots[binding.root]
		if (root === undefined) throw new Error(`missing pinned root ${binding.root}`)
		return root.value
	}
	const outputs = states.get(binding.nodeId)?.outputs
	if (outputs === undefined || !(binding.output in outputs)) {
		if (binding.optional === true) return undefined
		throw new Error(`missing output ${binding.nodeId}.${binding.output}`)
	}
	return outputs[binding.output]
}

function validateOutputs(
	node: PlannedNode,
	rawOutput: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const schemas = node.implementation.outputSchemas
	const outputNames = Object.keys(rawOutput).sort()
	const expectedNames = Object.keys(schemas).sort()
	if (outputNames.join('\u0000') !== expectedNames.join('\u0000')) {
		throw new Error(`operation ${node.implementation.id} returned the wrong output ports`)
	}
	const outputs: Record<string, unknown> = {}
	for (const name of expectedNames) {
		const schema = schemas[name]
		if (schema === undefined) throw new Error(`missing schema for ${node.id}.${name}`)
		outputs[name] = schema.parse(rawOutput[name])
	}
	return outputs
}

async function runOperationNode(
	node: PlannedNode,
	plan: ExecutionPlan,
	states: ReadonlyMap<string, NodeState>,
	dependencies: RunRecipeDependencies,
): Promise<{ state: NodeState; pending?: PendingCollection }> {
	if (dependencies.signal.aborted) {
		return {
			state: {
				nodeId: node.id,
				operation: node.operation,
				status: 'cancelled',
				error: dependencies.signal.reason,
			},
		}
	}
	for (const capability of node.implementation.requiredCapabilities) {
		if (!dependencies.capabilities.has(capability)) {
			const error = new Error(`runtime capability ${capability} is unavailable`)
			return {
				state: {
					nodeId: node.id,
					operation: node.operation,
					status: 'failed',
					error,
				},
			}
		}
	}
	const commonInputs: Record<string, unknown> = {}
	try {
		for (const [name, binding] of Object.entries(node.inputs)) {
			const schema = node.implementation.inputSchemas[name]
			if (schema === undefined) throw new Error(`missing input schema ${node.id}.${name}`)
			commonInputs[name] = schema.parse(resolveBinding(binding, plan, states))
		}
	} catch (error) {
		return {
			state: { nodeId: node.id, operation: node.operation, status: 'failed', error },
		}
	}

	if (node.kind === 'collection') {
		return runCollectionNode(node, commonInputs, plan, states, dependencies)
	}
	if (!dependencies.budget.claim({ kind: 'operation', amount: 1, nodeId: node.id })) {
		return {
			state: { nodeId: node.id, operation: node.operation, status: 'deferred' },
		}
	}
	let rawOutput: Readonly<Record<string, unknown>> | undefined
	try {
		rawOutput = await node.implementation.run(commonInputs, {
			...dependencies,
			revisions: plan.revisions,
			...(node.configuration === undefined
				? {}
				: { configuration: node.configuration }),
		})
		const outputs = validateOutputs(node, rawOutput)
		if (dependencies.signal.aborted) {
			return {
				state: {
					nodeId: node.id,
					operation: node.operation,
					status: 'cancelled',
					rawOutput,
					error: dependencies.signal.reason,
				},
			}
		}
		if (node.kind === 'gate') {
			const applies = outputs[node.appliesOutput]
			if (typeof applies !== 'boolean') {
				throw new Error(`gate ${node.id} did not return a boolean applies output`)
			}
			if (!applies) {
				return {
					state: {
						nodeId: node.id,
						operation: node.operation,
						status: 'not_applicable',
						rawOutput,
					},
				}
			}
		}
		return {
			state: {
				nodeId: node.id,
				operation: node.operation,
				status: 'succeeded',
				rawOutput,
				outputs,
			},
		}
	} catch (error) {
		return {
			state: {
				nodeId: node.id,
				operation: node.operation,
				status: 'failed',
				...(rawOutput === undefined ? {} : { rawOutput }),
				error,
			},
		}
	}
}

async function runCollectionNode(
	node: Extract<PlannedNode, { kind: 'collection' }>,
	commonInputs: Readonly<Record<string, unknown>>,
	plan: ExecutionPlan,
	states: ReadonlyMap<string, NodeState>,
	dependencies: RunRecipeDependencies,
): Promise<{ state: NodeState; pending?: PendingCollection }> {
	let items: readonly unknown[]
	try {
		const value = resolveBinding(node.items, plan, states)
		let sourceSchema
		if (node.items.source === 'root') {
			sourceSchema = plan.roots[node.items.root]?.schema
		} else {
			const itemBinding = node.items
			const producer = plan.nodes.find(({ id }) => id === itemBinding.nodeId)
			sourceSchema =
				producer?.kind === 'collection'
					? producer.outputSchemas[itemBinding.output]
					: producer?.implementation.outputSchemas[itemBinding.output]
		}
		if (sourceSchema === undefined) throw new Error(`missing collection input for ${node.id}`)
		items = sourceSchema.parse(value) as readonly unknown[]
	} catch (error) {
		return { state: { nodeId: node.id, operation: node.operation, status: 'failed', error } }
	}
	const selected = items.slice(0, node.limit)
	const pendingItems: unknown[] = [...items.slice(node.limit)]
	const aggregated = Object.fromEntries(
		Object.keys(node.implementation.outputSchemas).map((name) => [name, [] as unknown[]]),
	) as Record<string, unknown[]>
	const rawOutputs: unknown[] = []
	for (const [index, item] of selected.entries()) {
		if (dependencies.signal.aborted) {
			pendingItems.unshift(...selected.slice(index))
			return {
				state: {
					nodeId: node.id,
					operation: node.operation,
					status: 'cancelled',
					rawOutput: rawOutputs,
					error: dependencies.signal.reason,
				},
				pending: { nodeId: node.id, items: pendingItems },
			}
		}
		if (
			!dependencies.budget.claim({
				kind: 'operation',
				amount: 1,
				nodeId: node.id,
			}) ||
			!dependencies.budget.claim({
				kind: 'collection_item',
				amount: 1,
				nodeId: node.id,
			})
		) {
			pendingItems.unshift(...selected.slice(index))
			return {
				state: {
					nodeId: node.id,
					operation: node.operation,
					status: 'deferred',
					rawOutput: rawOutputs,
				},
				pending: { nodeId: node.id, items: pendingItems },
			}
		}
		try {
			const itemSchema = node.implementation.inputSchemas[node.itemInput]
			if (itemSchema === undefined) throw new Error(`missing item schema for ${node.id}`)
			const rawOutput = await node.implementation.run(
				{ ...commonInputs, [node.itemInput]: itemSchema.parse(item) },
				{
					...dependencies,
					revisions: plan.revisions,
					...(node.configuration === undefined
						? {}
						: { configuration: node.configuration }),
				},
			)
			rawOutputs.push(rawOutput)
			const outputs = validateOutputs(node, rawOutput)
			for (const [name, output] of Object.entries(outputs)) aggregated[name]?.push(output)
			if (dependencies.signal.aborted) {
				return {
					state: {
						nodeId: node.id,
						operation: node.operation,
						status: 'cancelled',
						rawOutput: rawOutputs,
						error: dependencies.signal.reason,
					},
					pending: { nodeId: node.id, items: [...items] },
				}
			}
		} catch (error) {
			pendingItems.unshift(...selected.slice(index))
			return {
				state: {
					nodeId: node.id,
					operation: node.operation,
					status: 'failed',
					rawOutput: rawOutputs,
					error,
				},
				pending: { nodeId: node.id, items: pendingItems },
			}
		}
	}
	const outputs: Record<string, unknown> = {}
	try {
		for (const [name, schema] of Object.entries(node.outputSchemas)) {
			outputs[name] = schema.parse(aggregated[name])
		}
	} catch (error) {
		return {
			state: {
				nodeId: node.id,
				operation: node.operation,
				status: 'failed',
				rawOutput: rawOutputs,
				error,
			},
			pending: { nodeId: node.id, items: [...items] },
		}
	}
	return {
		state: {
			nodeId: node.id,
			operation: node.operation,
			status: 'succeeded',
			rawOutput: rawOutputs,
			outputs,
		},
		...(pendingItems.length === 0
			? {}
			: { pending: { nodeId: node.id, items: pendingItems } }),
	}
}

function terminalResult(
	plan: ExecutionPlan,
	states: ReadonlyMap<string, NodeState>,
	pending: readonly PendingCollection[],
): LearningResult {
	const cancelled = [...states.values()].find(({ status }) => status === 'cancelled')
	if (cancelled !== undefined) return failure('cancelled', 'recipe execution was cancelled', true)
	const failed = [...states.values()].find(({ status }) => status === 'failed')
	if (failed !== undefined) {
		return failure('operation_failed', errorMessage(failed.error), true)
	}
	const deferred = [...states.values()].find(({ status }) => status === 'deferred')
	if (deferred !== undefined) {
		return {
			outcome: 'defer',
			reason: 'execution budget was exhausted',
			pending: pending.flatMap(({ items }) => items),
		}
	}
	if (
		plan.result.source === 'node' &&
		states.get(plan.result.nodeId)?.status === 'not_applicable'
	) {
		return { outcome: 'no_change', reason: 'not_applicable' }
	}
	try {
		return learningResultSchema.parse(resolveBinding(plan.result, plan, states))
	} catch (error) {
		return failure('invalid_result', errorMessage(error), false)
	}
}

export async function runRecipe(
	plan: ExecutionPlan,
	dependencies: RunRecipeDependencies,
): Promise<RecipeExecution> {
	const states = new Map<string, NodeState>()
	const pendingCollections: PendingCollection[] = []
	const waiting = new Set(plan.nodes.map(({ id }) => id))
	while (waiting.size > 0) {
		let settledBlocked = false
		for (const node of plan.nodes) {
			if (!waiting.has(node.id)) continue
			const predecessorStates = requiredNodeDependencies(node).map((id) => states.get(id))
			const blocker = predecessorStates.find(
				(state) => state !== undefined && state.status !== 'succeeded',
			)
			if (blocker === undefined) continue
			const status =
				blocker.status === 'not_applicable'
					? 'not_applicable'
					: blocker.status === 'cancelled'
						? 'cancelled'
						: blocker.status === 'deferred'
							? 'deferred'
							: 'failed'
			states.set(node.id, {
				nodeId: node.id,
				operation: node.operation,
				status,
				...(blocker.error === undefined ? {} : { error: blocker.error }),
			})
			waiting.delete(node.id)
			settledBlocked = true
		}
		const ready = plan.nodes.filter(
			(node) =>
				waiting.has(node.id) &&
				nodeDependencies(node).every((id) => states.has(id)) &&
				requiredNodeDependencies(node).every(
					(id) => states.get(id)?.status === 'succeeded',
				),
		)
		if (ready.length === 0) {
			if (settledBlocked) continue
			for (const id of waiting) {
				const node = plan.nodes.find((candidate) => candidate.id === id)
				if (node === undefined) continue
				states.set(id, {
					nodeId: id,
					operation: node.operation,
					status: 'failed',
					error: new Error('recipe execution made no progress'),
				})
			}
			waiting.clear()
			break
		}
		const results = await Promise.all(
			ready.map((node) => runOperationNode(node, plan, states, dependencies)),
		)
		for (const result of results) {
			states.set(result.state.nodeId, result.state)
			waiting.delete(result.state.nodeId)
			if (result.pending !== undefined) pendingCollections.push(result.pending)
		}
	}
	return {
		recipe: plan.recipe,
		revisions: plan.revisions,
		result: terminalResult(plan, states, pendingCollections),
		nodes: plan.nodes.map((node) => {
			const state = states.get(node.id)
			if (state === undefined) {
				return {
					nodeId: node.id,
					operation: node.operation,
					status: 'failed' as const,
					error: new Error('node was not settled'),
				}
			}
			const { outputs: _outputs, ...execution } = state
			return execution
		}),
		pending: pendingCollections,
		budget: dependencies.budget.snapshot(),
	}
}
