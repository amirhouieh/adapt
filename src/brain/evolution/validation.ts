import type { VersionRef } from '../../learning'
import type {
	EvolutionCatalogue,
	EvolutionDeveloperConstraints,
	EvolutionLensDefinition,
	EvolutionPolicy,
	EvolutionProposal,
	EvolutionRegressionCheck,
	EvolutionRegressionCheckResult,
	EvolutionSettingBound,
	EvolutionValidationIssue,
	EvolutionValidationResult,
	ValidatedEvolutionProposal,
} from './contracts'

const validatedProposals = new WeakSet<object>()

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (typeof value !== 'object' || value === null || seen.has(value))
		return value
	seen.add(value)
	for (const child of Object.values(value)) deepFreeze(child, seen)
	return Object.freeze(value)
}

export function snapshotValidatedEvolutionProposal(
	value: ValidatedEvolutionProposal,
): ValidatedEvolutionProposal {
	if (!validatedProposals.has(value)) {
		throw new Error(
			'evolution proposal was not produced by deterministic validation',
		)
	}
	return structuredClone(value)
}

function referenceKey(reference: VersionRef): string {
	return JSON.stringify([reference.id, reference.version])
}

function sameReferences(left: VersionRef[], right: VersionRef[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(reference, index) =>
				referenceKey(reference) === referenceKey(right[index]!),
		)
	)
}

function unique(values: readonly string[]): boolean {
	return new Set(values).size === values.length
}

function normalizedConstraints(
	lenses: EvolutionLensDefinition[],
): EvolutionDeveloperConstraints {
	const instructions = [
		...new Set(
			lenses.flatMap((lens) => lens.developer_constraints.instructions),
		),
	]
	const permissions =
		lenses.length === 0
			? []
			: lenses[0]!.developer_constraints.provider_permissions.filter(
					(permission) =>
						lenses.every((lens) =>
							lens.developer_constraints.provider_permissions.includes(
								permission,
							),
						),
				)
	return {
		instructions,
		local_only: lenses.some((lens) => lens.developer_constraints.local_only),
		provider_permissions: permissions,
	}
}

function constraintsEqual(
	left: EvolutionDeveloperConstraints,
	right: EvolutionDeveloperConstraints,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right)
}

function actionShapeIssues(
	proposal: EvolutionProposal,
	current: Map<string, EvolutionLensDefinition>,
): EvolutionValidationIssue[] {
	const issues: EvolutionValidationIssue[] = []
	const fail = (message: string): void => {
		issues.push({ code: 'invalid-action-shape', message })
	}
	if (!unique(proposal.target_lens_ids)) fail('target lens ids must be unique')
	if (!unique(proposal.resulting_lenses.map((lens) => lens.id))) {
		fail('resulting lens ids must be unique')
	}
	const retainedIds = new Set(
		[...current.keys()].filter((id) => !proposal.target_lens_ids.includes(id)),
	)
	if (proposal.resulting_lenses.some((lens) => retainedIds.has(lens.id))) {
		fail('a resulting lens id collides with an unrelated retained lens')
	}
	if (proposal.target_lens_ids.some((id) => !current.has(id))) {
		fail('every target lens must exist in the pinned registry')
	}
	if (proposal.action === 'create') {
		if (
			proposal.target_lens_ids.length !== 0 ||
			proposal.resulting_lenses.length < 1
		) {
			fail('create requires no targets and at least one resulting lens')
		}
		if (proposal.resulting_lenses.some((lens) => current.has(lens.id))) {
			fail('create cannot replace an existing lens id')
		}
	} else if (proposal.action === 'update') {
		if (
			proposal.target_lens_ids.length !== 1 ||
			proposal.resulting_lenses.length !== 1 ||
			proposal.target_lens_ids[0] !== proposal.resulting_lenses[0]?.id
		)
			fail('update requires one target and the same single resulting lens id')
	} else if (proposal.action === 'merge') {
		if (
			proposal.target_lens_ids.length < 2 ||
			proposal.resulting_lenses.length !== 1
		) {
			fail('merge requires at least two targets and one resulting lens')
		}
	} else if (proposal.action === 'split') {
		if (
			proposal.target_lens_ids.length !== 1 ||
			proposal.resulting_lenses.length < 2
		) {
			fail('split requires one target and at least two resulting lenses')
		}
	} else if (
		proposal.target_lens_ids.length < 1 ||
		proposal.resulting_lenses.length !== 0
	) {
		fail('delete requires at least one target and no resulting lenses')
	}
	return issues
}

function resultingRegistry(
	current: EvolutionLensDefinition[],
	proposal: EvolutionProposal,
): EvolutionLensDefinition[] {
	const removed = new Set(proposal.target_lens_ids)
	return [
		...current.filter((lens) => !removed.has(lens.id)),
		...proposal.resulting_lenses,
	]
}

function settingIssue(
	lens: EvolutionLensDefinition,
	key: string,
	value: string | number | boolean | null,
	bound: EvolutionSettingBound | undefined,
): EvolutionValidationIssue | undefined {
	if (!bound) {
		return {
			code: 'invalid-setting',
			message: `setting ${key} is not permitted`,
			lens_id: lens.id,
		}
	}
	const validType =
		(bound.kind === 'number' &&
			typeof value === 'number' &&
			Number.isFinite(value)) ||
		(bound.kind === 'integer' &&
			typeof value === 'number' &&
			Number.isSafeInteger(value)) ||
		(bound.kind === 'boolean' && typeof value === 'boolean') ||
		(bound.kind === 'string' && typeof value === 'string')
	if (!validType) {
		return {
			code: 'invalid-setting',
			message: `setting ${key} has an invalid type`,
			lens_id: lens.id,
		}
	}
	if (typeof value === 'number') {
		if (bound.minimum !== undefined && value < bound.minimum) {
			return {
				code: 'invalid-setting',
				message: `setting ${key} is below its minimum`,
				lens_id: lens.id,
			}
		}
		if (bound.maximum !== undefined && value > bound.maximum) {
			return {
				code: 'invalid-setting',
				message: `setting ${key} exceeds its maximum`,
				lens_id: lens.id,
			}
		}
	}
	if (
		bound.allowed_values &&
		!bound.allowed_values.includes(value as string | number | boolean)
	) {
		return {
			code: 'invalid-setting',
			message: `setting ${key} is outside its allowed values`,
			lens_id: lens.id,
		}
	}
	return undefined
}

function cycleIssue(
	registry: EvolutionLensDefinition[],
): EvolutionValidationIssue | undefined {
	const byId = new Map(registry.map((lens) => [lens.id, lens]))
	const visiting = new Set<string>()
	const visited = new Set<string>()
	const visit = (id: string): boolean => {
		if (visiting.has(id)) return true
		if (visited.has(id)) return false
		visiting.add(id)
		for (const dependency of byId.get(id)?.dependencies ?? []) {
			if (!byId.has(dependency) || visit(dependency)) return true
		}
		visiting.delete(id)
		visited.add(id)
		return false
	}
	for (const id of byId.keys()) {
		if (visit(id)) {
			return {
				code: 'dependency-cycle',
				message: 'lens dependencies must exist and remain acyclic',
			}
		}
	}
	return undefined
}

function catalogueIssues(
	proposal: EvolutionProposal,
	registry: EvolutionLensDefinition[],
	catalogue: EvolutionCatalogue,
	policy: EvolutionPolicy,
): EvolutionValidationIssue[] {
	const issues: EvolutionValidationIssue[] = []
	const recipeByKey = new Map(
		catalogue.recipes.map((recipe) => [referenceKey(recipe), recipe]),
	)
	const schemas = new Set(catalogue.memory_schemas.map(referenceKey))
	for (const lens of proposal.resulting_lenses) {
		const recipe = recipeByKey.get(referenceKey(lens.recipe))
		if (!recipe || !recipe.memory_types.includes(lens.type)) {
			issues.push({
				code: 'unapproved-recipe',
				message: 'lens recipe is not approved for its memory type',
				lens_id: lens.id,
			})
		} else {
			for (const capability of recipe.required_capabilities) {
				if (!policy.available_capabilities.includes(capability)) {
					issues.push({
						code: 'missing-capability',
						message: `missing capability ${capability}`,
						lens_id: lens.id,
					})
				}
			}
		}
		if (!schemas.has(referenceKey(lens.memory_schema))) {
			issues.push({
				code: 'incompatible-schema',
				message: 'lens memory schema is not approved',
				lens_id: lens.id,
			})
		}
		if (lens.recipe_composition.length > policy.max_recipe_steps) {
			issues.push({
				code: 'budget-exceeded',
				message: 'recipe composition exceeds the step limit',
				lens_id: lens.id,
			})
		}
		const composition = catalogue.compositions.find((entry) =>
			sameReferences(entry.recipes, lens.recipe_composition),
		)
		if (
			!composition ||
			lens.recipe_composition.length > composition.max_steps
		) {
			issues.push({
				code: 'unapproved-composition',
				message: 'recipe composition is not approved',
				lens_id: lens.id,
			})
		}
		for (const reference of lens.recipe_composition) {
			const composedRecipe = recipeByKey.get(referenceKey(reference))
			if (!composedRecipe || !composedRecipe.memory_types.includes(lens.type)) {
				issues.push({
					code: 'unapproved-composition',
					message: 'composed recipe is not approved for the lens memory type',
					lens_id: lens.id,
				})
				continue
			}
			for (const capability of composedRecipe.required_capabilities) {
				if (!policy.available_capabilities.includes(capability)) {
					issues.push({
						code: 'missing-capability',
						message: `missing capability ${capability}`,
						lens_id: lens.id,
					})
				}
			}
		}
		if (lens.dependencies.length > policy.max_dependencies_per_lens) {
			issues.push({
				code: 'budget-exceeded',
				message: 'lens exceeds the dependency limit',
				lens_id: lens.id,
			})
		}
		for (const [key, value] of Object.entries(lens.settings)) {
			const issue = settingIssue(
				lens,
				key,
				value,
				policy.setting_bounds.find((bound) => bound.key === key),
			)
			if (issue) issues.push(issue)
		}
		if (!lens.developer_constraints.local_only) {
			issues.push({
				code: 'protected-constraint',
				message: 'the local-only constraint must remain enabled',
				lens_id: lens.id,
			})
		}
	}
	if (registry.length > policy.max_lenses) {
		issues.push({
			code: 'budget-exceeded',
			message: 'resulting registry exceeds the lens limit',
		})
	}
	return issues
}

function transformationIssues(
	proposal: EvolutionProposal,
	targets: EvolutionLensDefinition[],
	catalogue: EvolutionCatalogue,
): EvolutionValidationIssue[] {
	if (proposal.action === 'create' || proposal.action === 'delete') return []
	const sourceSchemas = targets.map((lens) => lens.memory_schema)
	const targetSchemas = proposal.resulting_lenses.map(
		(lens) => lens.memory_schema,
	)
	const requiresTransformation =
		proposal.action === 'merge' ||
		proposal.action === 'split' ||
		!sameReferences(sourceSchemas, targetSchemas)
	if (!proposal.transformation) {
		return requiresTransformation
			? [
					{
						code: 'incompatible-schema',
						message: 'the proposal requires an explicit transformation',
					},
				]
			: []
	}
	const transformation = catalogue.transformations.find(
		(entry) =>
			referenceKey(entry) === referenceKey(proposal.transformation!) &&
			sameReferences(entry.source_schemas, sourceSchemas) &&
			sameReferences(entry.target_schemas, targetSchemas),
	)
	return transformation
		? []
		: [
				{
					code: 'incompatible-schema',
					message:
						'the proposed transformation is not approved for these schemas',
				},
			]
}

export async function validateEvolutionProposal(input: {
	proposal: EvolutionProposal
	current_registry: EvolutionLensDefinition[]
	evidence_ids: string[]
	catalogue: EvolutionCatalogue
	policy: EvolutionPolicy
	checks: EvolutionRegressionCheck[]
}): Promise<EvolutionValidationResult> {
	const snapshot = structuredClone({
		proposal: input.proposal,
		current_registry: input.current_registry,
		evidence_ids: input.evidence_ids,
		catalogue: input.catalogue,
		policy: input.policy,
	})
	const issues = actionShapeIssues(
		snapshot.proposal,
		new Map(snapshot.current_registry.map((lens) => [lens.id, lens])),
	)
	if (
		!unique(snapshot.proposal.evidence_ids) ||
		snapshot.proposal.evidence_ids.length === 0 ||
		snapshot.proposal.evidence_ids.some(
			(id) => !snapshot.evidence_ids.includes(id),
		)
	)
		issues.push({
			code: 'missing-evidence',
			message: 'proposal evidence must reference supplied evidence',
		})

	if (
		snapshot.proposal.target_lens_ids.some((id) =>
			snapshot.policy.protected_lens_ids.includes(id),
		)
	) {
		issues.push({
			code: 'protected-constraint',
			message: 'a protected lens cannot evolve',
		})
	}
	const targets = snapshot.proposal.target_lens_ids
		.map((id) => snapshot.current_registry.find((lens) => lens.id === id))
		.filter((lens): lens is EvolutionLensDefinition => lens !== undefined)
	if (
		snapshot.proposal.action === 'update' &&
		targets[0] &&
		snapshot.proposal.resulting_lenses[0]
	) {
		if (
			!constraintsEqual(
				targets[0].developer_constraints,
				snapshot.proposal.resulting_lenses[0].developer_constraints,
			)
		) {
			issues.push({
				code: 'protected-constraint',
				message: 'update must preserve developer constraints verbatim',
			})
		}
	} else if (snapshot.proposal.action === 'create') {
		for (const lens of snapshot.proposal.resulting_lenses) {
			if (
				!constraintsEqual(
					snapshot.policy.creation_constraints,
					lens.developer_constraints,
				)
			) {
				issues.push({
					code: 'protected-constraint',
					message:
						'create must use the developer-supplied constraint template verbatim',
					lens_id: lens.id,
				})
			}
		}
	} else if (targets.length > 0 && snapshot.proposal.action !== 'delete') {
		const expected = normalizedConstraints(targets)
		for (const lens of snapshot.proposal.resulting_lenses) {
			if (!constraintsEqual(expected, lens.developer_constraints)) {
				issues.push({
					code: 'protected-constraint',
					message:
						'reorganization must preserve normalized developer constraints verbatim',
					lens_id: lens.id,
				})
			}
		}
	}
	if (snapshot.proposal.action === 'delete') {
		if (
			!snapshot.proposal.deletion_mode ||
			!snapshot.policy.allowed_deletion_modes.includes(
				snapshot.proposal.deletion_mode,
			)
		)
			issues.push({
				code: 'invalid-deletion-policy',
				message: 'delete requires an explicitly permitted deletion mode',
			})
	} else if (snapshot.proposal.deletion_mode) {
		issues.push({
			code: 'invalid-deletion-policy',
			message: 'deletion mode is valid only for delete actions',
		})
	}

	const registry = resultingRegistry(
		snapshot.current_registry,
		snapshot.proposal,
	)
	issues.push(
		...catalogueIssues(
			snapshot.proposal,
			registry,
			snapshot.catalogue,
			snapshot.policy,
		),
	)
	issues.push(
		...transformationIssues(snapshot.proposal, targets, snapshot.catalogue),
	)
	const dependencyIssue = cycleIssue(registry)
	if (dependencyIssue) issues.push(dependencyIssue)

	const requiredChecks =
		snapshot.policy.required_regression_checks[snapshot.proposal.action]
	for (const id of requiredChecks) {
		if (!snapshot.proposal.regression_check_ids.includes(id)) {
			issues.push({
				code: 'missing-regression-check',
				message: `missing required regression check ${id}`,
			})
		}
	}
	const checksById = new Map(input.checks.map((check) => [check.id, check]))
	const checkResults: EvolutionRegressionCheckResult[] = []
	for (const id of snapshot.proposal.regression_check_ids) {
		const check = checksById.get(id)
		if (!check) {
			issues.push({
				code: 'missing-regression-check',
				message: `regression check ${id} is not registered`,
			})
			continue
		}
		const result = await check.run({
			proposal: structuredClone(snapshot.proposal),
			current_registry: structuredClone(snapshot.current_registry),
		})
		checkResults.push(structuredClone(result))
		if (!result.passed) {
			issues.push({
				code: 'regression-check-failed',
				message: `regression check ${id} failed`,
			})
		}
	}
	if (issues.length > 0) {
		return { status: 'invalid', issues, regression_checks: checkResults }
	}
	const value = deepFreeze({
		proposal: structuredClone(snapshot.proposal),
		source_registry: structuredClone(snapshot.current_registry),
		registry: structuredClone(registry),
		regression_checks: checkResults,
	})
	validatedProposals.add(value)
	return {
		status: 'valid',
		value,
	}
}
