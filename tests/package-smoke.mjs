import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = process.cwd()

async function run(command, args, cwd) {
	const { stdout, stderr } = await execFileAsync(command, args, {
		cwd,
		maxBuffer: 10 * 1024 * 1024,
	})
	return { stdout, stderr }
}

async function createProject(dir, name, { type = 'module' } = {}) {
	await mkdir(dir, { recursive: true })
	await writeFile(
		join(dir, 'package.json'),
		JSON.stringify(
			{
				name,
				private: true,
				type,
			},
			null,
			2,
		),
	)
}

async function writeNodeSmoke(dir) {
	await writeFile(
		join(dir, 'smoke.mjs'),
		`import assert from 'node:assert/strict'
import { SQLiteBrainStore, SQLiteNeuronStore } from 'adapt-memory/sqlite'

const brainPath = './brain.db'
const neuronPath = './neuron.db'

{
  const brainStore = new SQLiteBrainStore(brainPath)
  await brainStore.state.add({
    id: 'prompt',
    value: 'Track packaged install smoke.',
    updated_at: new Date().toISOString(),
  })
  await brainStore.neurons.add({ id: 'engineering-decisions', type: 'text' })
  await brainStore.dispose()
}

{
  const reopenedBrain = new SQLiteBrainStore(brainPath)
  const prompt = await reopenedBrain.state.get('prompt')
  assert.equal(prompt?.value, 'Track packaged install smoke.')
  assert.equal(await reopenedBrain.neurons.count(), 1)
  await reopenedBrain.dispose()
}

{
  const neuronStore = new SQLiteNeuronStore(neuronPath)
  await neuronStore.state.add({
    id: 'instructions',
    value: 'Track packaging smoke.',
    updated_at: new Date().toISOString(),
  })
  await neuronStore.understanding.add({
    id: 'current',
    data: 'Packaged Node install can persist and restore SQLite data.',
    metadata_confidence: 0.95,
    metadata_created_at: new Date().toISOString(),
    metadata_updated_at: new Date().toISOString(),
  })
  await neuronStore.dispose()
}

{
  const reopenedNeuron = new SQLiteNeuronStore(neuronPath)
  const understanding = await reopenedNeuron.understanding.get('current')
  assert.equal(
    understanding?.data,
    'Packaged Node install can persist and restore SQLite data.',
  )
  await reopenedNeuron.dispose()
}
`,
	)
}

async function writeBunSmoke(dir) {
	await writeFile(
		join(dir, 'smoke.mjs'),
		`import assert from 'node:assert/strict'
import { SQLiteBrainStore, SQLiteNeuronStore } from 'adapt-memory/sqlite/bun'

const brainPath = './brain.db'
const neuronPath = './neuron.db'

{
  const brainStore = new SQLiteBrainStore(brainPath)
  await brainStore.state.add({
    id: 'prompt',
    value: 'Track packaged Bun install smoke.',
    updated_at: new Date().toISOString(),
  })
  await brainStore.neurons.add({ id: 'engineering-decisions', type: 'text' })
  await brainStore.dispose()
}

{
  const reopenedBrain = new SQLiteBrainStore(brainPath)
  const prompt = await reopenedBrain.state.get('prompt')
  assert.equal(prompt?.value, 'Track packaged Bun install smoke.')
  assert.equal(await reopenedBrain.neurons.count(), 1)
  await reopenedBrain.dispose()
}

{
  const neuronStore = new SQLiteNeuronStore(neuronPath)
  await neuronStore.state.add({
    id: 'instructions',
    value: 'Track packaging smoke.',
    updated_at: new Date().toISOString(),
  })
  await neuronStore.understanding.add({
    id: 'current',
    data: 'Packaged Bun install can persist and restore SQLite data.',
    metadata_confidence: 0.95,
    metadata_created_at: new Date().toISOString(),
    metadata_updated_at: new Date().toISOString(),
  })
  await neuronStore.dispose()
}

{
  const reopenedNeuron = new SQLiteNeuronStore(neuronPath)
  const understanding = await reopenedNeuron.understanding.get('current')
  assert.equal(
    understanding?.data,
    'Packaged Bun install can persist and restore SQLite data.',
  )
  await reopenedNeuron.dispose()
}
`,
	)
}

async function packTarball() {
	const { stdout } = await run('npm', ['pack', '--json'], repoRoot)
	const parsed = JSON.parse(stdout)
	const filename = parsed[0]?.filename
	assert.equal(typeof filename, 'string')
	return resolve(repoRoot, filename)
}

async function runNodeSmoke(tarballPath, tempRoot) {
	const projectDir = join(tempRoot, 'node-app')
	await createProject(projectDir, 'adapt-node-smoke')
	await writeNodeSmoke(projectDir)
	await run('npm', ['install', tarballPath, 'better-sqlite3'], projectDir)
	await run('node', ['smoke.mjs'], projectDir)
}

async function writeNodeCjsSmoke(dir) {
	await writeFile(
		join(dir, 'smoke.cjs'),
		`const assert = require('node:assert/strict')
const { SQLiteBrainStore, SQLiteNeuronStore } = require('adapt-memory/sqlite')
const { Brain, MemoryBrainStore, MemoryNeuronStore, Neuron } = require('adapt-memory')

assert.equal(typeof Brain, 'function')
assert.equal(typeof MemoryBrainStore, 'function')
assert.equal(typeof MemoryNeuronStore, 'function')
assert.equal(typeof Neuron, 'function')

const brainPath = './brain.db'
const neuronPath = './neuron.db'

;(async () => {
  {
    const brainStore = new SQLiteBrainStore(brainPath)
    await brainStore.state.add({
      id: 'prompt',
      value: 'Track CJS install smoke.',
      updated_at: new Date().toISOString(),
    })
    await brainStore.neurons.add({ id: 'cjs-smoke', type: 'text' })
    await brainStore.dispose()
  }

  {
    const reopenedBrain = new SQLiteBrainStore(brainPath)
    const prompt = await reopenedBrain.state.get('prompt')
    assert.equal(prompt?.value, 'Track CJS install smoke.')
    assert.equal(await reopenedBrain.neurons.count(), 1)
    await reopenedBrain.dispose()
  }

  {
    const neuronStore = new SQLiteNeuronStore(neuronPath)
    await neuronStore.understanding.add({
      id: 'current',
      data: 'CJS require() can load adapt and persist SQLite data.',
      metadata_confidence: 0.95,
      metadata_created_at: new Date().toISOString(),
      metadata_updated_at: new Date().toISOString(),
    })
    await neuronStore.dispose()
  }

  {
    const reopenedNeuron = new SQLiteNeuronStore(neuronPath)
    const understanding = await reopenedNeuron.understanding.get('current')
    assert.equal(
      understanding?.data,
      'CJS require() can load adapt and persist SQLite data.',
    )
    await reopenedNeuron.dispose()
  }
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
`,
	)
}

async function runNodeCjsSmoke(tarballPath, tempRoot) {
	const projectDir = join(tempRoot, 'node-cjs-app')
	await createProject(projectDir, 'adapt-node-cjs-smoke', { type: 'commonjs' })
	await writeNodeCjsSmoke(projectDir)
	await run('npm', ['install', tarballPath, 'better-sqlite3'], projectDir)
	await run('node', ['smoke.cjs'], projectDir)
}

async function runBunSmoke(tarballPath, tempRoot) {
	const projectDir = join(tempRoot, 'bun-app')
	await createProject(projectDir, 'adapt-bun-smoke')
	await writeBunSmoke(projectDir)
	await run('bun', ['add', tarballPath], projectDir)
	await run('bun', ['run', 'smoke.mjs'], projectDir)
}

async function main() {
	const tempRoot = await mkdtemp(join(tmpdir(), 'adapt-package-smoke-'))
	const tarballPath = await packTarball()

	try {
		await runNodeSmoke(tarballPath, tempRoot)
		await runNodeCjsSmoke(tarballPath, tempRoot)
		await runBunSmoke(tarballPath, tempRoot)
		console.log('package smoke: node (esm + cjs) and bun passed')
	} finally {
		await rm(tempRoot, { recursive: true, force: true })
		await rm(tarballPath, { force: true })
	}
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
