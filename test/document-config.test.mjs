import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { loadConfig } from '../src/config.mjs';

async function bundle(t, change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'document-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../examples/text-inbox/', import.meta.url), root, { recursive: true });
  const filename = join(root, 'agent.yaml'), config = parse(await readFile(filename, 'utf8'));
  config.schema_version = 2; config.model.capabilities.images = true;
  config.documents = { images: { enabled: true }, output: { format: 'text' } };
  change(config); await writeFile(filename, stringify(config)); return filename;
}

test('explicit schema2 image recipe has coherent bounded defaults and separate context reservation', async t => {
  const { config } = await loadConfig(await bundle(t));
  assert.deepEqual(config.documents.images, { enabled: true, max_count: 4, max_file_bytes: 5242880, max_total_bytes: 10485760, max_pixels: 12000000 });
  assert.deepEqual(config.documents.output, { format: 'text', filename: 'transcription.txt', max_bytes: 262144 });
  assert.equal(config.model.image_context_tokens, 8192); assert.equal(config.limits.context_tokens, 65536);
  assert.ok(config.model.image_context_tokens * 4 + config.limits.output_tokens + 256 < config.limits.context_tokens);
});

test('document inbox example loads through the same schema and secret validation as a customer bundle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'document-example-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('../examples/document-inbox/', import.meta.url), root, { recursive: true });
  const { config } = await loadConfig(join(root, 'agent.yaml'), {
    env: { INBOX_GRAPH_CLIENT_SECRET: 'synthetic-graph-secret', INBOX_MODEL_API_KEY: 'synthetic-model-key' },
    requireSecrets: true,
  });
  assert.equal(config.schema_version, 2);
  assert.equal(config.documents.images.enabled, true);
  assert.equal(config.documents.output.format, 'text-attachment');
  assert.equal(config.documents.output.filename, 'transcription.txt');
  assert.equal(config.model.capabilities.images, true);
});

test('schema2 disabled image recipe stays text-only and does not infer capability', async t => {
  const { config } = await loadConfig(await bundle(t, value => { value.documents.images.enabled = false; value.model.capabilities.images = false; }));
  assert.equal(config.documents.images.enabled, false); assert.equal(config.documents.output.format, 'text');
});

test('document output requires explicit fixed generated text capability', async t => {
  const { config } = await loadConfig(await bundle(t, value => { value.documents.output.format = 'text-attachment'; value.documents.output.max_bytes = 2000000; }));
  assert.equal(config.documents.output.format, 'text-attachment'); assert.equal(config.documents.output.filename, 'transcription.txt');
});

for (const [name, change] of [
  ['schema1 recipe fields', value => { value.schema_version = 1; }],
  ['schema1 image reservation', value => { value.schema_version = 1; value.model.image_context_tokens = 8192; delete value.documents; value.model.capabilities.images = false; }],
  ['unknown document option', value => { value.documents.secret_override = true; }],
  ['missing documents', value => { delete value.documents; }],
  ['capability mismatch', value => { value.model.capabilities.images = false; }],
  ['disabled mismatch', value => { value.documents.images.enabled = false; }],
  ['unsupported PDF', value => { value.model.capabilities.pdf = true; }],
  ['count cap', value => { value.documents.images.max_count = 5; }],
  ['file cap', value => { value.documents.images.max_file_bytes = 5242881; }],
  ['aggregate cap', value => { value.documents.images.max_total_bytes = 10485761; }],
  ['pixel cap', value => { value.documents.images.max_pixels = 20000001; }],
  ['unsafe output name', value => { value.documents.output.filename = '../secret.txt'; }],
  ['output cap', value => { value.documents.output.max_bytes = 2000001; }],
  ['attachment without images', value => { value.documents.images.enabled = false; value.model.capabilities.images = false; value.documents.output.format = 'text-attachment'; }],
  ['context reserve does not fit', value => { value.limits = { context_tokens: 16384 }; }],
  ['file exceeds aggregate', value => { value.documents.images.max_total_bytes = 1024; }],
]) test(`rejects ${name}`, async t => { await assert.rejects(loadConfig(await bundle(t, change))); });

test('a qualified stricter single-image profile fits an explicitly smaller context', async t => {
  const { config } = await loadConfig(await bundle(t, value => { value.documents.images.max_count = 1; value.limits = { context_tokens: 16384 }; }));
  assert.equal(config.documents.images.max_count, 1); assert.equal(config.limits.context_tokens, 16384);
});
