export interface VersionRef {
	readonly id: string
	readonly version: string
}

export interface ValueSchema<T = unknown> extends VersionRef {
	readonly parse: (value: unknown) => T
	readonly accepts?: (producer: ValueSchema) => boolean
	readonly collectionItem?: ValueSchema
}

type SchemaValue<TSchema extends ValueSchema> =
	TSchema extends ValueSchema<infer TValue> ? TValue : never

type ValuesFor<TSchemas extends Readonly<Record<string, ValueSchema>>> = {
	readonly [TKey in keyof TSchemas]: SchemaValue<TSchemas[TKey]>
}

export function defineSchema<T>(schema: ValueSchema<T>): ValueSchema<T> {
	return Object.freeze(schema)
}

export function arraySchema<T>(
	id: string,
	version: string,
	item: ValueSchema<T>,
): ValueSchema<readonly T[]> {
	let schema: ValueSchema<readonly T[]>
	schema = defineSchema({
		id,
		version,
		collectionItem: item,
		parse(value) {
			if (!Array.isArray(value)) throw new Error(`${id}@${version} requires an array`)
			return value.map((entry) => item.parse(entry))
		},
		accepts(producer) {
			return (
				producer === schema ||
				(producer.collectionItem !== undefined &&
					schemaAccepts(item, producer.collectionItem))
			)
		},
	})
	return schema
}

export function schemaAccepts(
	consumer: ValueSchema,
	producer: ValueSchema,
): boolean {
	return consumer === producer || consumer.accepts?.(producer) === true
}

export type MemoryType = 'text' | 'list' | 'graph' | (string & {})

export type RootValue = {
	readonly schema: ValueSchema
	readonly value: unknown
}

export type InputBinding =
	| { readonly source: 'root'; readonly root: string }
	| {
			readonly source: 'node'
			readonly nodeId: string
			readonly output: string
			readonly optional?: boolean
	  }

export interface OperationContext {
	readonly signal: AbortSignal
	readonly capabilities: CapabilityResolver
	readonly budget: BudgetController
	readonly revisions: RevisionPins
	readonly configuration?: unknown
}

export interface Operation extends VersionRef {
	readonly inputSchemas: Readonly<Record<string, ValueSchema>>
	readonly outputSchemas: Readonly<Record<string, ValueSchema>>
	readonly configurationSchema?: ValueSchema
	readonly requiredCapabilities: readonly string[]
	readonly memoryTypes?: readonly MemoryType[]
	run(
		inputs: Readonly<Record<string, unknown>>,
		context: OperationContext,
	): Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>
}

export type OperationDefinition<
	TInputs extends Readonly<Record<string, ValueSchema>>,
	TOutputs extends Readonly<Record<string, ValueSchema>>,
> = Omit<Operation, 'inputSchemas' | 'outputSchemas' | 'run'> & {
	readonly inputSchemas: TInputs
	readonly outputSchemas: TOutputs
	run(
		inputs: ValuesFor<TInputs>,
		context: OperationContext,
	):
		| Promise<ValuesFor<TOutputs>>
		| ValuesFor<TOutputs>
}

export function defineOperation<
	TInputs extends Readonly<Record<string, ValueSchema>>,
	TOutputs extends Readonly<Record<string, ValueSchema>>,
>(operation: OperationDefinition<TInputs, TOutputs>): Operation {
	return operation as Operation
}

export interface CapabilityResolver {
	has(id: string): boolean
	get<T = unknown>(id: string): T | undefined
}

export type BudgetClaim = {
	readonly kind: 'operation' | 'collection_item' | 'provider_call' | 'tokens'
	readonly amount: number
	readonly nodeId: string
}

export interface BudgetController {
	claim(claim: BudgetClaim): boolean
	snapshot(): unknown
}

export type RecipeNode = OperationNode | GateNode | CollectionNode

interface NodeBase {
	readonly id: string
	readonly operation: VersionRef
	readonly inputs: Readonly<Record<string, InputBinding>>
	readonly after?: readonly string[]
	readonly configuration?: unknown
}

export interface OperationNode extends NodeBase {
	readonly kind: 'operation'
}

export interface GateNode extends NodeBase {
	readonly kind: 'gate'
	readonly appliesOutput: string
}

export interface CollectionNode extends NodeBase {
	readonly kind: 'collection'
	readonly itemInput: string
	readonly items: InputBinding
	readonly limit: number
	readonly outputSchemas: Readonly<Record<string, ValueSchema>>
}

export interface Recipe extends VersionRef {
	readonly memoryTypes?: readonly MemoryType[]
	readonly nodes: readonly RecipeNode[]
	readonly result: InputBinding
}

export type RevisionPins = {
	readonly memory: number
	readonly configuration: number
	readonly registry: string
}

export interface PlanningLimits {
	readonly maxNodes: number
	readonly maxCollectionItems: number
	readonly maxOperations: number
}

export interface ExecutionPlan {
	readonly recipe: VersionRef
	readonly memoryType: MemoryType
	readonly revisions: RevisionPins
	readonly roots: Readonly<Record<string, RootValue>>
	readonly nodes: readonly PlannedNode[]
	readonly result: InputBinding
}

export type PlannedNode = RecipeNode & {
	readonly implementation: Operation
}

export type LearningChange = {
	readonly outcome: 'change'
	readonly patch: unknown
	readonly expectedMemoryRevision: number
	readonly expectedConfigurationRevision: number
	readonly consumedInputIds?: readonly string[]
	readonly uncertainty?: unknown
	readonly explanation?: string
	readonly candidateSignals?: readonly unknown[]
	readonly pendingInputIds?: readonly string[]
	readonly diagnostics?: unknown
}

export type LearningNoChange = {
	readonly outcome: 'no_change'
	readonly reason?: string
	readonly consumedInputIds?: readonly string[]
	readonly pendingInputIds?: readonly string[]
	readonly diagnostics?: unknown
}

export type LearningDeferred = {
	readonly outcome: 'defer'
	readonly reason: string
	readonly pending?: readonly unknown[]
	readonly consumedInputIds?: readonly string[]
	readonly pendingInputIds?: readonly string[]
	readonly diagnostics?: unknown
}

export type LearningFailure = {
	readonly outcome: 'failure'
	readonly code: string
	readonly reason: string
	readonly retryable: boolean
	readonly diagnostics?: unknown
}

export type LearningResult =
	| LearningChange
	| LearningNoChange
	| LearningDeferred
	| LearningFailure

function parseLearningResult(value: unknown): LearningResult {
	if (typeof value !== 'object' || value === null || !('outcome' in value)) {
		throw new Error('learning result requires an outcome')
	}
	const result = value as Record<string, unknown>
	if (
		result.outcome !== 'change' &&
		result.outcome !== 'no_change' &&
		result.outcome !== 'defer' &&
		result.outcome !== 'failure'
	) {
		throw new Error('learning result has an unsupported outcome')
	}
	if (result.outcome === 'change') {
		if (
			!('patch' in result) ||
			!Number.isInteger(result.expectedMemoryRevision) ||
			!Number.isInteger(result.expectedConfigurationRevision)
		) {
			throw new Error('change result requires a patch and revision pins')
		}
	}
	if (result.outcome === 'defer' && typeof result.reason !== 'string') {
		throw new Error('defer result requires a reason')
	}
	if (
		(result.outcome === 'change' || result.outcome === 'no_change' || result.outcome === 'defer') &&
		result.consumedInputIds !== undefined &&
		(!Array.isArray(result.consumedInputIds) ||
			result.consumedInputIds.some((id) => typeof id !== 'string'))
	) {
		throw new Error('consumedInputIds must contain only strings')
	}
	if (
		(result.outcome === 'change' || result.outcome === 'no_change' || result.outcome === 'defer') &&
		result.pendingInputIds !== undefined &&
		(!Array.isArray(result.pendingInputIds) ||
			result.pendingInputIds.some((id) => typeof id !== 'string'))
	) {
		throw new Error('pendingInputIds must contain only strings')
	}
	if (
		result.outcome === 'change' &&
		result.explanation !== undefined &&
		typeof result.explanation !== 'string'
	) {
		throw new Error('explanation must be a string')
	}
	if (
		result.outcome === 'change' &&
		result.candidateSignals !== undefined &&
		!Array.isArray(result.candidateSignals)
	) {
		throw new Error('candidateSignals must be an array')
	}
	if (
		result.outcome === 'defer' &&
		result.pending !== undefined &&
		!Array.isArray(result.pending)
	) {
		throw new Error('pending must be an array')
	}
	if (
		result.outcome === 'failure' &&
		(typeof result.code !== 'string' ||
			typeof result.reason !== 'string' ||
			typeof result.retryable !== 'boolean')
	) {
		throw new Error('failure result requires code, reason, and retryable')
	}
	return value as LearningResult
}

export const learningResultSchema = defineSchema<LearningResult>({
	id: 'adapt.learning-result',
	version: '1',
	parse: parseLearningResult,
})

export type NodeExecution = {
	readonly nodeId: string
	readonly operation: VersionRef
	readonly status:
		| 'succeeded'
		| 'not_applicable'
		| 'deferred'
		| 'failed'
		| 'cancelled'
	readonly rawOutput?: unknown
	readonly error?: unknown
}

export type PendingCollection = {
	readonly nodeId: string
	readonly items: readonly unknown[]
}

export interface RecipeExecution {
	readonly recipe: VersionRef
	readonly revisions: RevisionPins
	readonly result: LearningResult
	readonly nodes: readonly NodeExecution[]
	readonly pending: readonly PendingCollection[]
	readonly budget: unknown
}
