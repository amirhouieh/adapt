/** Original v1 tasks, matched local Qwen runs. Raw evidence; no automatic semantic grading. */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { TextNeuron, createAiSdkLLM, type AdaptLLMPlugin } from '../../src'
import { SQLiteNeuronStore } from '../../src/sqlite'
import { createAdaptTextProcedureProvider, createConservativeByteTokenCounter, twoStepRecipeRef, type TextLearningConfig } from '../../src/learning/text-procedures'
import type { TextProfileSnapshot } from '../../src/learning/text-state'
import type { AdaptiveTextLearningRuntime } from '../../src/neurons/text'
import { createBoundedDeviceScheduler } from '../../src/llm/local/scheduler'

const root = resolve(import.meta.dirname, '../..')
const baseline = resolve(root, '../adapt-memory-v1-baseline')
const originals = resolve(root, '../adapt-memory')
const models = ['qwen/qwen3.5-2b', 'qwen/qwen3.5-9b']
const settings = { temperature: 0, maxOutputTokens: 2048, maxRetries: 0, timeout: 120000 }
interface Task {
  id: string
  instructions: string
  metadata: Record<string, unknown>
  inputs: Array<{ id: string; text: string; timestamp: string }>
  checkpoints: number[]
  questions: string[]
  batchSize: number
  coffee?: { narrowedInstructions: string; before: string[]; after: string[]; final: string[] }
}
interface ProviderConfig { name: string; baseURL: string; apiKeyEnv?: string }
interface ComparisonConfig { provider: ProviderConfig; models: string[]; settings: typeof settings; outputRoot: string; memoryOnly?: boolean; loadedContextTokens?: number; requestBodyExtras?: Record<string, unknown> }
interface Suite { createdAt: string; baseline: string; settings: typeof settings; models: string[]; tasks: Task[]; sourceHashes: Record<string, string>; disclosures: string[]; provider?: ProviderConfig; memoryOnly?: boolean; loadedContextTokens?: number; requestBodyExtras?: Record<string, unknown> }
const replacer = (_key: string, value: unknown): unknown => value instanceof Error ? { name: value.name, message: value.message, stack: value.stack, cause: value.cause } : value
function json(path: string, value: unknown): void { writeFileSync(path, JSON.stringify(value, replacer, 2) + '\n') }
function hash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }
function sourceHashes(): Record<string, string> {
  const result: Record<string, string> = {}
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name.endsWith('.ts')) result[path] = hash(path)
    }
  }
  visit(resolve(root, 'src')); visit(resolve(baseline, 'src'))
  result[resolve(root, 'evals/scripts/original-v1-qwen-comparison.ts')] = hash(resolve(root, 'evals/scripts/original-v1-qwen-comparison.ts'))
  return result
}
function prepare(configPath?: string): string {
  const supplied = configPath ? JSON.parse(readFileSync(resolve(configPath), 'utf8')) as ComparisonConfig : undefined
  if (supplied && (!supplied.provider?.name || !supplied.provider.baseURL || !supplied.models?.length || !supplied.settings || !supplied.outputRoot)) throw new Error('comparison provider configuration is incomplete')
  const directory = resolve(root, supplied?.outputRoot ?? 'evals/.data/original-v1-qwen', new Date().toISOString().replaceAll(':', '-'))
  mkdirSync(directory, { recursive: true })
  const tasks: Task[] = []
  for (const id of ['preference-evolution', 'personal-behavior', 'developer-memory', 'therapist-profile']) {
    const path = resolve(originals, 'evals/datasets', `${id}.json`)
    const raw = readFileSync(path, 'utf8')
    const data = JSON.parse(raw) as { metadata: { learner?: { purpose: string }; learners?: Array<{ purpose: string }>; queries: string[] } & Record<string, unknown>; events: Array<{ id: string; timestamp: string; type: string; content: string; source?: string; author?: string }> }
    writeFileSync(resolve(directory, `${id}.original.json`), raw)
    const count = data.events.length
    tasks.push({ id, instructions: (data.metadata.learner ?? data.metadata.learners?.[0])!.purpose, metadata: data.metadata,
      inputs: data.events.map(event => ({ id: event.id, text: `[${event.timestamp}] [${event.type}]${event.source ? ` [source: ${event.source}]` : ''}${event.author ? ` [author: ${event.author}]` : ''}\n${event.content}`, timestamp: event.timestamp })),
      checkpoints: [...new Set([Math.ceil(count / 2 / 8) * 8, count])], questions: data.metadata.queries, batchSize: 8 })
  }
  const coffeePath = resolve(originals, 'evals/scripts/text-neuron-semantic-eval.ts')
  const coffeeSource = readFileSync(coffeePath, 'utf8')
  const ast = ts.createSourceFile(coffeePath, coffeeSource, ts.ScriptTarget.Latest, true)
  const batches: string[][] = []
  let coffeeInstructions = ''
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.getText(ast) === 'neuron.learn' && node.arguments[0] && ts.isArrayLiteralExpression(node.arguments[0])) {
      batches.push(node.arguments[0].elements.map(element => { if (!ts.isStringLiteral(element)) throw new Error('coffee input is not a string'); return element.text }))
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'instructions' && !coffeeInstructions) {
      function literal(value: ts.Expression): string {
        if (ts.isStringLiteral(value)) return value.text
        if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) return literal(value.left) + literal(value.right)
        throw new Error('unexpected coffee instructions')
      }
      coffeeInstructions = literal(node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (batches.length !== 2 || batches[0]!.length !== 3 || batches[1]!.length !== 4) throw new Error('original coffee fixture shape changed')
  writeFileSync(resolve(directory, 'coffee.original.ts'), coffeeSource)
  tasks.unshift({ id: 'coffee', instructions: coffeeInstructions, metadata: { source: coffeePath, objectives: ['Preserve brewing methods, temperatures, ratios, techniques.', 'Answer relevant queries and identify missing cold-brew knowledge.', 'Narrow instructions to espresso and filter unrelated cold-brew input.', 'Switch continuous to cumulative strategy.', 'Expose event lifecycle.'] },
    inputs: batches.flat().map((text, index) => ({ id: `coffee-${index + 1}`, text, timestamp: '2026-11-03T00:00:00.000Z' })), checkpoints: [3, 7], questions: [], batchSize: 3,
    coffee: { narrowedInstructions: 'You are an espresso specialist. Focus exclusively on espresso brewing: machine types, grind settings, extraction theory, milk texturing, and latte art. Ignore non-espresso brewing methods.', before: ['How do I make pour-over coffee?', 'What is the ideal temperature for cold brew?'], after: ['How do I make pour-over coffee?', 'What pressure should espresso be brewed at?'], final: ['Summarize everything you know about espresso'] } })
  const suite: Suite = { createdAt: new Date().toISOString(), baseline: spawnSync('git', ['-C', baseline, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), settings: supplied?.settings ?? settings, models: supplied?.models ?? models, tasks, sourceHashes: sourceHashes(), ...(supplied ? { provider: supplied.provider, memoryOnly: supplied.memoryOnly ?? false, ...(supplied.loadedContextTokens ? { loadedContextTokens: supplied.loadedContextTokens } : {}), ...(supplied.requestBodyExtras ? { requestBodyExtras: supplied.requestBodyExtras } : {}) } : {}), disclosures: [
    'Original v1 records. Quality judgment uses the user criterion of learning quality over time, from committed understanding only; query answers are excluded.',
    'One repetition per task, model, arm. The v2 arm runs the fixed two-step text procedure.',
    'Dataset tasks run as standalone generic TextNeurons. This is not the original complete-Brain behavior evaluation.',
    'Common input text uses the original v1 behavior formatter: [timestamp] [type] [source: source] newline content. Other original datasets omit the source tag when absent and include their author tag when present. Event IDs remain in delivery metadata; all event content and timestamps are preserved.',
    'Common receipt groups of 8 with forced flush; coffee retains original groups of 3 then 4 and scope change. Threshold changes are disclosed in checkpoint records.',
    supplied ? `Provider and generation settings are saved explicitly. The v2 declared model context is ${supplied.loadedContextTokens ?? 8192}; remote model native context and reasoning behavior differ from local Qwen. Results do not isolate model weights alone.` : 'Common local settings: 8192 loaded context, temperature 0, output limit 2048, no provider retries. Model thinking is already off for both Qwen installations.',
    ...(supplied?.requestBodyExtras ? [`Every provider request body in both arms is merged with ${JSON.stringify(supplied.requestBodyExtras)} before sending; the wire request records the merged body.`] : []),
    ...(supplied?.memoryOnly ? ['Memory-only collection: query calls are omitted in both arms; original question text is retained as source metadata. Coffee instruction and governance changes still run.'] : []),
    'Original v1 baseline is imported unchanged. Both public API and wire evidence are retained. Default public query paths may differ between versions.',
    'No matching public v2 ListNeuron or complete v2 Brain path exists. Restaurant lists and complete Brain behavior remain uncovered.',
    'Original datasets are synthetic. This is a development comparison, not a new held-out benchmark.'
  ] }
  json(resolve(directory, 'suite.json'), suite)
  console.log(directory)
  return directory
}

async function worker(directory: string, modelId: string, arm: string, taskId: string): Promise<void> {
  const suite = JSON.parse(readFileSync(resolve(directory, 'suite.json'), 'utf8')) as Suite
  const settings = suite.settings
  if (!suite.models.includes(modelId) || !['v1', 'v2twostep'].includes(arm)) throw new Error('unconfigured model or arm')
  // v2twostep: production procedure adapt.text-procedure.two-step@1 through the real coordinator and SQLite store.
  // Plain text, so no requestBodyExtras (thinking stays at the model default) and memory bound only by the output budget.
  const twoStep = arm === 'v2twostep'
  for (const [path, expected] of Object.entries(suite.sourceHashes)) if (hash(path) !== expected) throw new Error(`source changed: ${path}`)
  const task = suite.tasks.find(candidate => candidate.id === taskId)!
  if (!task) throw new Error('unconfigured task')
  const job = resolve(directory, modelId.split('/').at(-1)!, arm, taskId)
  mkdirSync(job, { recursive: true })
  let phase = 'initialize'
  let wireCalls = 0
  let promptTokens = 0
  let completionTokens = 0
  let providerFailure: Error | undefined
  const wireFetch: typeof fetch = async (input, init) => {
    const extras = twoStep ? undefined : suite.requestBodyExtras
    const request = extras && typeof init?.body === 'string' ? new Request(input, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...extras }) }) : new Request(input, init)
    const call = resolve(job, 'wire', String(++wireCalls).padStart(5, '0'))
    mkdirSync(call, { recursive: true })
    json(resolve(call, 'metadata.json'), { phase, startedAt: new Date().toISOString(), url: request.url })
    writeFileSync(resolve(call, 'request.json'), await request.clone().text())
    const started = Date.now()
    try {
      const response = await fetch(request)
      const body = await response.clone().text()
      writeFileSync(resolve(call, 'response.json'), body)
      const parsed = JSON.parse(body) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
      promptTokens += parsed.usage?.prompt_tokens ?? 0; completionTokens += parsed.usage?.completion_tokens ?? 0
      json(resolve(call, 'completion.json'), { status: response.status, elapsedMs: Date.now() - started })
      providerFailure = response.ok ? undefined : new Error(`provider returned HTTP ${response.status}; this job is not a valid semantic run`)
      return response
    } catch (error) { providerFailure = error instanceof Error ? error : new Error(String(error)); json(resolve(call, 'error.json'), error); throw error }
  }
  const providerConfig = suite.provider ?? { name: 'lmstudio', baseURL: 'http://localhost:1234/v1' }
  const apiKey = providerConfig.apiKeyEnv ? process.env[providerConfig.apiKeyEnv] : undefined
  if (providerConfig.apiKeyEnv && !apiKey) throw new Error(`missing credential environment variable ${providerConfig.apiKeyEnv}`)
  const provider = createOpenAICompatible({ name: providerConfig.name, baseURL: providerConfig.baseURL, ...(apiKey ? { apiKey } : {}), supportsStructuredOutputs: true, fetch: wireFetch })
  const model = provider(modelId)
  const legacy = arm === 'v1' ? { ...(await import(pathToFileURL(resolve(baseline, 'src/index.ts')).href)), ...(await import(pathToFileURL(resolve(baseline, 'src/sqlite.ts')).href)) } as { TextNeuron: typeof TextNeuron; SQLiteNeuronStore: typeof SQLiteNeuronStore; createAiSdkLLM: typeof createAiSdkLLM } : undefined
  const makePlugin = legacy?.createAiSdkLLM ?? createAiSdkLLM
  const basePlugin = makePlugin({ providers: { [model.provider]: ((id: string) => { if (id !== modelId) throw new Error('unexpected model'); return model }) } })
  const llm: AdaptLLMPlugin = { ...basePlugin, async call(request) {
    const supplied = { ...request, settings: { ...request.settings, ...settings } }
    appendFileSync(resolve(job, 'plugin-calls.jsonl'), JSON.stringify({ phase, request: supplied }, replacer) + '\n')
    return basePlugin.call(supplied)
  } }
  const strategy = task.coffee ? 'continuous' : 'cumulative'
  const configuration: TextLearningConfig = { model: { id: modelId, version: '1' }, activeProcedure: twoStepRecipeRef, allowedProcedures: [twoStepRecipeRef],
    lens: { purpose: task.instructions, developerInstructions: [], instructionPrecedence: ['developer instructions', 'incoming data'], incomingTextRole: 'data-only' },
    batching: { maxItems: 8, maxInputCharacters: 8000, maxInputTokens: 8000, maxDelayMs: 3600000, acceptCallerUrgency: true },
    input: { maxItemCharacters: 2000 },
    memory: { maxCharacters: 4 * settings.maxOutputTokens, allowExplicitClear: false },
    generation: { loadedContextTokens: suite.loadedContextTokens ?? 8192, reservedOutputTokens: settings.maxOutputTokens, maxProviderCalls: 48, maxTokenClaims: 240000, maxBudgetClaims: 64 },
    planning: { maxNodes: 2, maxCollectionItems: 8, maxOperations: 2 },
    retries: { maxLogicalAttempts: 3, initialDelayMs: 1000, maxDelayMs: 4000, terminalAfterMs: 3600000 },
    history: { maxEntries: 64, maxCharacters: 8000 },
    idempotence: { processedIdHorizonMs: 86400000, maxProcessedIds: 1000 } }
  const ref = { id: `original-v1-${taskId}`, version: '1' }
  const neuronId = `${taskId}-${arm}`
  const initialProfile: TextProfileSnapshot<TextLearningConfig> = { ref, revision: 1, configuration, bindings: {
    neuron: { id: neuronId, incarnation: 'original-v1-comparison', ownership_revision: 1 }, profile: ref, profile_revision: 1,
    procedure: configuration.activeProcedure, model: configuration.model, registry_lineage: 'original-v1-comparison', referenced_definition_digest: hash(resolve(root, 'src/learning/text-procedures/two-step.ts')), allowed_catalogue_digest: 'fixed-two-step-v1'
  }, createdAt: suite.createdAt }
  const tokens = createConservativeByteTokenCounter({ requestTemplateOverheadTokens: 64, textTemplateOverheadTokens: 0 })
  const runtime: AdaptiveTextLearningRuntime = { models: [{ ref: configuration.model, tokens, provider: createAdaptTextProcedureProvider({ llm, model, settings, scheduler: createBoundedDeviceScheduler({ maxConcurrent: 1, maxQueued: 4 }), priority: 'background' }) }],
    stateIds: { next: kind => `${kind}-${randomUUID()}` }, inputIds: { next: () => randomUUID() }, clock: { now: () => new Date().toISOString() },
    scheduler: { schedule(dueAt, callback) { const handle = setTimeout(callback, Math.max(0, Date.parse(dueAt) - Date.now())); handle.unref(); return handle }, cancel(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>) } },
    policy: { maxRetainedProfiles: 8, maxFlushRuns: 64, headStateId: 'adaptive-text-profile-head', narrativeMemoryId: 'current', stateKind: 'adaptive-text-learning' }, countInputTokens: inputs => inputs.reduce((sum, item) => sum + tokens.countText(item.text).tokens, 0), onError: error => appendFileSync(resolve(job, 'runtime-errors.jsonl'), JSON.stringify(error, replacer) + '\n') }
  const Core = legacy?.TextNeuron ?? TextNeuron
  const Store = legacy?.SQLiteNeuronStore ?? SQLiteNeuronStore
  const database = resolve(job, 'memory.sqlite')
  let store = new Store(database)
  const started = Date.now()
  const failures: unknown[] = []
  const onEvent = (event: unknown): void => { appendFileSync(resolve(job, 'events.jsonl'), JSON.stringify({ phase, event }, replacer) + '\n') }
  json(resolve(job, 'input.json'), { task, modelId, arm, configuration: arm !== 'v1' ? configuration : { instructions: task.instructions, governance: { strategy, maxTokens: 16000 }, understand: { thresholds: { maxObservations: task.batchSize, maxTokens: 8000, minImportance: task.coffee ? 0.3 : 0.5 } } }, settings })
  let neuron = await Core.create({ id: neuronId, model, llm, store, instructions: task.instructions, onEvent,
    ...(arm !== 'v1' ? { learning: { mode: 'adaptive' as const, initialProfile, runtime } } : {
      governance: { strategy, maxTokens: 16000 }, understand: { thresholds: { maxObservations: task.batchSize, maxTokens: 8000, minImportance: task.coffee ? 0.3 : 0.5 } }
    }) })
  async function queries(questions: string[], label: string): Promise<void> {
    if (suite.memoryOnly) return
    const results = []
    for (const question of questions) {
      phase = `${label}:query:${question}`
      try { results.push({ question, result: await neuron.query(question) }) }
      catch (error) { failures.push({ phase, error }); results.push({ question, error }) }
      json(resolve(job, `${label}.queries.json`), results)
    }
  }
  try {
    let cursor = 0
    while (cursor < task.inputs.length) {
      const end = task.coffee ? (cursor === 0 ? 3 : 7) : Math.min(cursor + task.batchSize, task.inputs.length)
      const items = task.inputs.slice(cursor, end)
      phase = `learn:${cursor + 1}-${end}`
      const result = await neuron.learn(arm === 'v1' ? items.map(item => item.text) : items.map(item => ({ deliveryId: item.id, eventId: item.id, text: item.text, observedAt: new Date(item.timestamp).toISOString() })), { forceSynthesize: true })
      appendFileSync(resolve(job, 'deliveries.jsonl'), JSON.stringify({ phase, result }, replacer) + '\n')
      // A deferred two-step run (cut-off answer) is retried by the coordinator's own timer; wait for the queue to drain.
      for (let waited = 0; twoStep && (await neuron.getLearningState()).pendingDeliveryIds.length > 0 && waited < 900; waited += 1) await new Promise(done => setTimeout(done, 1000))
      if (twoStep) appendFileSync(resolve(job, 'deliveries.jsonl'), JSON.stringify({ phase, drained: (await neuron.getLearningState()).pendingDeliveryIds }, replacer) + '\n')
      if (providerFailure) throw providerFailure
      if (result.status === 'observe:error' || result.status === 'synthesize:error') failures.push({ phase, result })
      cursor = end
      json(resolve(job, 'progress.json'), { afterInput: cursor, total: task.inputs.length, calls: wireCalls, seconds: (Date.now() - started) / 1000 })
      if (task.checkpoints.includes(cursor)) {
        phase = `checkpoint:${cursor}`
        const understanding = await neuron.getUnderstanding()
        const state = arm !== 'v1' ? await neuron.getLearningState() : { buffer: await neuron.getBufferState(), metrics: neuron.getMetrics() }
        json(resolve(job, `checkpoint-${cursor}.json`), { afterInput: cursor, understanding, state })
        if (task.coffee && cursor === 3) {
          await queries(task.coffee.before, 'coffee-before')
          phase = 'coffee:scope-update'
          json(resolve(job, 'coffee-scope-update.json'), await neuron.update({ instructions: task.coffee.narrowedInstructions }))
          if (arm === 'v1') json(resolve(job, 'coffee-threshold-update.json'), await neuron.update({ understand: { thresholds: { minImportance: 0.7 } } }))
          else json(resolve(job, 'coffee-threshold-update.json'), { unsupported: 'Adaptive mode has no legacy importance threshold; the two-step extract step decides relevance. The original scope change is still exercised.' })
          json(resolve(job, 'coffee-governance-update.json'), twoStep ? { unsupported: 'Adaptive text has no governance strategy (two-step never compacts). The scope change still runs.' } : await neuron.update({ governance: { strategy: 'cumulative' } }))
          await queries(task.coffee.after, 'coffee-after')
        }
        if (cursor === task.inputs.length) await queries(task.coffee?.final ?? task.questions, 'final')
        await neuron.dispose()
        store = new Store(database)
        phase = `restore:${cursor}`
        neuron = await Core.restore(store, { id: neuronId, model, llm, onEvent, ...(arm !== 'v1' ? { learning: { mode: 'adaptive' as const, runtime } } : {}) })
        json(resolve(job, `reopen-${cursor}.json`), { before: understanding, after: await neuron.getUnderstanding() })
      }
    }
    json(resolve(job, 'final.json'), { understanding: await neuron.getUnderstanding(), state: arm !== 'v1' ? await neuron.getLearningState() : { buffer: await neuron.getBufferState(), metrics: neuron.getMetrics() }, failures, calls: wireCalls, promptTokens, completionTokens, seconds: (Date.now() - started) / 1000 })
  } finally { await neuron.dispose() }
}

const [mode, directory, modelId, arm, task] = process.argv.slice(2)
if (mode === '--prepare') prepare(directory)
else if (mode === '--worker' && directory && modelId && arm && task) {
  worker(resolve(directory), modelId, arm, task).catch(error => { const job = resolve(directory, modelId.split('/').at(-1)!, arm, task); mkdirSync(job, { recursive: true }); json(resolve(job, 'fatal.json'), error); console.error(error); process.exitCode = 1 })
} else throw new Error('Use --prepare or --worker <suite-directory> <model> <v1|v2twostep> <task>')
