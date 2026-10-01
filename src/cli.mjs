#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import {mailboxIdentity} from './state-identity.mjs';
import {maintenanceLimits} from './maintenance-limits.mjs';
import { createFixtureMail, createFixtureModel, createFixtureMcp, loadFixture } from './fixture.mjs';

const help = `Mail Agent\n  init --directory DIR --recipe text-inbox [--interactive]\n    [--mailbox ADDRESS --tenant ID --client ID --model-url HTTPS_URL --model NAME]\n    [--senders ADDRESSES --recipients ADDRESSES --auth-profile dmarc|internal]\n    [--authserv-ids HOSTS | --from-domains DOMAINS]\n    [--id NAME --state-root PATH --graph-secret-env NAME --model-key-env NAME]\n  doctor --config FILE [--live] [--json]\n  check --config FILE [--live]\n  preview REQUEST.json --config FILE\n  start --config FILE [--once]\n  health --config FILE\n  status --config FILE [--limit 1..100] [--after CURSOR] [--state STATUS]\n  approvals --config FILE [--limit 1..100] [--after CURSOR]\n  approve --config FILE --id ID --actor ADDRESS --reason TEXT\n  resolve --config FILE --run ID --outcome sent|not-sent --actor ADDRESS --reason TEXT\n`;
const initFields = {
  id: 'id', mailbox: 'mailbox', tenant: 'tenant', client: 'client', 'model-url': 'modelUrl', model: 'model',
  senders: 'senders', recipients: 'recipients', 'auth-profile': 'authProfile', 'authserv-ids': 'authservIds',
  'from-domains': 'fromDomains', 'state-root': 'stateRoot', 'graph-secret-env': 'graphSecretEnv', 'model-key-env': 'modelKeyEnv',
};
const maintenanceHelp='  backup --config FILE --directory DIR [--max-bytes 1..17179869184] [--timeout-seconds 1..600]\n'
  +'  restore --config FILE --snapshot DIR --actor ADDRESS --reason TEXT [--max-bytes N] [--timeout-seconds N]\n'
  +'  recovery-inspect --config FILE [--kind runs|actions] [--limit 1..100] [--after CURSOR]\n';
const recoveryHelp='  recovery-preview --config FILE --plan FILE\n'
  +'  recovery-apply --config FILE --plan FILE --digest HASH --actor ADDRESS --reason TEXT\n'
  +'  recovery-release-preview --config FILE --plan FILE --actor ADDRESS --reason TEXT\n'
  +'  recovery-release-apply --config FILE --plan FILE --digest HASH --actor ADDRESS --reason TEXT\n';
const recordsHelp = '  records-intent --config FILE --action HASH --actor ADDRESS --reason TEXT\n'
  + '  reconcile-records --config FILE --action HASH --receipt FILE --actor ADDRESS --reason TEXT\n';
const options = {
  'records-intent': ['config', 'action', 'actor', 'reason'],
  'reconcile-records': ['config', 'action', 'receipt', 'actor', 'reason'],
  backup:['config','directory','max-bytes','timeout-seconds'],
  restore:['config','snapshot','actor','reason','max-bytes','timeout-seconds'],
  'recovery-inspect':['config','kind','limit','after'],
  'recovery-preview':['config','plan'],
  'recovery-apply':['config','plan','digest','actor','reason'],
  'recovery-release-preview':['config','plan','actor','reason'],
  'recovery-release-apply':['config','plan','digest','actor','reason'],
  init: ['directory', 'recipe', 'interactive', ...Object.keys(initFields)], check: ['config', 'live'], preview: ['config'], start: ['config', 'once'],
  doctor: ['config', 'live', 'json'],
  health: ['config'], status: ['config', 'limit', 'after', 'state'], approvals: ['config', 'limit', 'after'], approve: ['config', 'id', 'actor', 'reason'],
  resolve: ['config', 'run', 'outcome', 'actor', 'reason'],
};
const required = { init: ['directory', 'recipe'], backup:['directory'],restore:['snapshot','actor','reason'], approve: ['id', 'actor', 'reason'], resolve: ['run', 'outcome', 'actor', 'reason'] };
required['recovery-preview']=['plan'];
required['recovery-apply']=['plan','digest','actor','reason'];
required['recovery-release-preview']=['plan','actor','reason'];
required['recovery-release-apply']=['plan','digest','actor','reason'];
required['reconcile-records'] = ['action', 'receipt', 'actor', 'reason'];
required['records-intent'] = ['action', 'actor', 'reason'];

function readOption(command, args, index, values) {
  const argument = args[index];
  const key = argument.slice(2);
  if (!argument.startsWith('--') || !options[command].includes(key) || Object.hasOwn(values, key)) throw new Error(`Unknown or repeated option: ${argument}`);
  if (['live', 'once', 'json', 'interactive'].includes(key)) { values[key] = true; return index; }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
  values[key] = value;
  return index + 1;
}

function validateArguments(command, values, request) {
  for (const key of required[command] ?? []) if (!values[key]?.trim()) throw new Error(`Missing --${key}`);
  if (command !== 'init' && !values.config) throw new Error('Missing --config');
  if (command === 'preview' && !request) throw new Error('Missing fixture request JSON path');
  if (command === 'resolve' && !['sent', 'not-sent'].includes(values.outcome)) throw new Error('--outcome must be sent or not-sent');
  validateCommandOptions(command,values);
}

function validateCommandOptions(command,values) {
  if (['status','approvals','recovery-inspect'].includes(command)) metadataOptions(values);
  if (command==='recovery-inspect' && values.kind!==undefined && !['runs','actions'].includes(values.kind)) throw new Error('Unsupported recovery page kind');
  if (['backup','restore'].includes(command)) backupLimits(values);
  if (command==='restore' && values.reason.length>2048) throw new Error('--reason exceeds the maintenance limit');
  validateRecoveryOptions(command,values);
  validateRecordsOptions(command, values);
}

function validateRecordsOptions(command, values) {
  if (!['reconcile-records', 'records-intent'].includes(command)) return;
  if (!/^[a-f0-9]{64}$/.test(values.action) || values.actor.length > 254 || values.reason.length > 2048) {
    throw new Error('Records reconciliation denied.');
  }
}

function validateRecoveryOptions(command,values) {
  if (!['recovery-apply','recovery-release-preview','recovery-release-apply'].includes(command)) return;
  if(values.reason.length>2048) throw new Error('Invalid recovery operator reason');
  if(command==='recovery-release-preview') return;
  if (!/^[a-f0-9]{64}$/.test(values.digest)) throw new Error('Invalid recovery review digest');
}

function backupLimits(values) {
  return maintenanceLimits({
    ...(values['max-bytes']!==undefined?{maxBytes:Number(values['max-bytes'])}:{}),
    ...(values['timeout-seconds']!==undefined?{timeoutMs:Number(values['timeout-seconds'])*1000}:{})
  });
}

function metadataOptions(values) {
  const params = {};
  if (values.limit !== undefined) {
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be an integer from 1 to 100');
    params.limit = limit;
  }
  if (values.after !== undefined) {
    if (values.after.length > 1024) throw new Error('--after exceeds the cursor limit');
    params.after = values.after;
  }
  if (values.state !== undefined) {
    if (!['queued', 'running', 'awaiting_approval', 'ready_to_send', 'sending', 'completed', 'failed', 'ignored', 'uncertain'].includes(values.state)) throw new Error('Unsupported --state');
    params.status = values.state;
  }
  return params;
}

function parseArguments(argv) {
  const [command, ...args] = argv;
  if (!Object.hasOwn(options, command)) throw new Error('Unknown command; run mail-agent --help');
  const values = {};
  let request;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith('--') && command === 'preview' && !request) { request = argument; continue; }
    index = readOption(command, args, index, values);
  }
  validateArguments(command, values, request);
  return { command, values, request };
}

async function defaultInitialize(settings) {
  const { initializeAgent } = await import('./init.mjs');
  return initializeAgent(settings);
}

function initializeCommand(values, { initialize = defaultInitialize, ask, env }) {
  const answers = Object.fromEntries(Object.entries(initFields)
    .filter(([flag]) => Object.hasOwn(values, flag)).map(([flag, key]) => [key, values[flag]]));
  const settings = { directory: values.directory, recipe: values.recipe, guided: Boolean(values.interactive), answers, env };
  if (ask) settings.ask = ask;
  if (initialize === defaultInitialize) settings.command = [process.execPath, realpathSync(fileURLToPath(import.meta.url))];
  return initialize(settings);
}

function validateActor(actor) {
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(actor)) throw new Error('--actor must be an email address identifying the local operator');
}

async function defaultRuntime(settings) {
  const { createRuntime } = await import('./runtime.mjs');
  return createRuntime(settings);
}

async function defaultBackupState(settings) {
  const {backupState}=await import('./backup.mjs');
  return backupState(settings);
}

function backupCommand(loaded,values,backupState=defaultBackupState) {
  return backupState({stateRoot:loaded.config.state_root,directory:resolve(values.directory),identity:mailboxIdentity(loaded.config),...backupLimits(values)});
}

async function defaultRestoreState(settings) {
  const {restoreState}=await import('./restore.mjs');
  return restoreState(settings);
}

async function defaultInspectRecovery(settings) {
  const {inspectRecovery}=await import('./recovery-inspect.mjs');
  return inspectRecovery(settings);
}

async function defaultReadRecoveryPlanFile(filename) {
  const {readRecoveryPlanFile}=await import('./recovery-io.mjs');
  return readRecoveryPlanFile(filename);
}

async function defaultParseReceiptFile(filename) {
  const { parseReceiptFile } = await import('./records-reconciliation.mjs');
  return parseReceiptFile(filename);
}

async function operatorValues(command, values, { parseReceiptFile = defaultParseReceiptFile }) {
  if (command !== 'reconcile-records') return values;
  return { ...values, receipt: await parseReceiptFile(resolve(values.receipt)) };
}

async function defaultPreviewRecovery(settings) {
  const {previewRecovery}=await import('./recovery-apply.mjs');
  return previewRecovery(settings);
}

async function defaultApplyRecovery(settings) {
  const {applyRecovery}=await import('./recovery-apply.mjs');
  return applyRecovery(settings);
}

async function recoveryPlanCommand(command,loaded,values,{
  readRecoveryPlanFile=defaultReadRecoveryPlanFile,previewRecovery=defaultPreviewRecovery,applyRecovery=defaultApplyRecovery
}) {
  const settings={stateRoot:loaded.config.state_root,identity:mailboxIdentity(loaded.config),agentId:loaded.config.id,
    configHash:loaded.hash,limits:loaded.config.limits,contentHours:loaded.config.retention.content_hours,
    plan:await readRecoveryPlanFile(resolve(values.plan))};
  if (command==='recovery-preview') return previewRecovery(settings);
  return applyRecovery({...settings,actor:values.actor,reason:values.reason,expectedPlanDigest:values.digest});
}

function maintenanceCommand(command,loaded,values,services) {
  if(['recovery-release-preview','recovery-release-apply'].includes(command)) return recoveryReleaseCommand(command,loaded,values,services);
  if (['recovery-preview','recovery-apply'].includes(command)) return recoveryPlanCommand(command,loaded,values,services);
  return snapshotCommand(command,loaded,values,services);
}

async function defaultPreviewRecoveryRelease(settings) {
  const {previewRecoveryRelease}=await import('./recovery-release.mjs');
  return previewRecoveryRelease(settings);
}

async function defaultApplyRecoveryRelease(settings) {
  const {applyRecoveryRelease}=await import('./recovery-release.mjs');
  return applyRecoveryRelease(settings);
}

async function recoveryReleaseCommand(command,loaded,values,{
  readRecoveryPlanFile=defaultReadRecoveryPlanFile,previewRecoveryRelease=defaultPreviewRecoveryRelease,
  applyRecoveryRelease=defaultApplyRecoveryRelease,env
}) {
  const settings={stateRoot:loaded.config.state_root,identity:mailboxIdentity(loaded.config),configHash:loaded.hash,
    config:loaded.config,env,plan:await readRecoveryPlanFile(resolve(values.plan)),actor:values.actor,reason:values.reason};
  if(command==='recovery-release-preview') return previewRecoveryRelease(settings);
  return applyRecoveryRelease({...settings,expectedReviewDigest:values.digest});
}

function snapshotCommand(command,loaded,values,{backupState,restoreState=defaultRestoreState,inspectRecovery=defaultInspectRecovery}) {
  if (command==='backup') return backupCommand(loaded,values,backupState);
  if (command==='recovery-inspect') return recoveryInspectionCommand(loaded,values,inspectRecovery);
  return restoreState({stateRoot:loaded.config.state_root,snapshot:resolve(values.snapshot),identity:mailboxIdentity(loaded.config),
    actor:values.actor,reason:values.reason,...backupLimits(values)});
}

async function recoveryInspectionCommand(loaded,values,inspectRecovery) {
  const mailbox=mailboxIdentity(loaded.config);
  const report=await inspectRecovery({stateRoot:loaded.config.state_root,identity:mailbox,
    ...(values.kind!==undefined?{kind:values.kind}:{}),...metadataOptions(values)});
  return {...report,configHash:loaded.hash,mailboxIdentity:mailbox,agentId:loaded.config.id};
}

async function dispatch(runtime, command, values) {
  if (command === 'check') return runtime.liveCheck();
  if (command === 'status') return runtime.status(metadataOptions(values));
  if (command === 'approvals') return runtime.approvals(metadataOptions(values));
  if (command === 'approve') return runtime.approve({ id: values.id, actor: values.actor, reason: values.reason });
  if (command === 'resolve') return runtime.resolve({ runId: values.run, outcome: values.outcome, actor: values.actor, reason: values.reason });
  if (command === 'reconcile-records') return runtime.reconcileRecords({ actionKey: values.action, receipt: values.receipt,
    actor: values.actor, reason: values.reason });
  if (command === 'records-intent') return runtime.recordsIntent({ actionKey: values.action, actor: values.actor, reason: values.reason });
  throw new Error(`Unsupported runtime command: ${command}`);
}

async function start(runtime, once) {
  const stop = () => { void runtime.stop().catch(() => {}); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { return await runtime.start({ once }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

async function executeCommand(runtime, command, values, request) {
  if (command === 'preview') return { mode: 'fixture-preview', message: 'Offline deterministic fixture; this does not assess live model quality or send email.', result: await runtime.processMessage(await loadFixture(request)) };
  if (command === 'start') return start(runtime, Boolean(values.once));
  return dispatch(runtime, command, values);
}

function runtimeSettings(loaded, command, live, env) {
  const mode = command === 'preview' ? 'preview' : live ? 'live' : 'operator';
  const settings = { ...loaded, mode, env };
  if (command === 'preview') {
    settings.model = createFixtureModel(); settings.mail = createFixtureMail(); settings.mcp = createFixtureMcp();
  }
  return settings;
}

async function executeArguments(argv, services) {
  const {createRuntime,env,initialize,ask}=services;
  const { command, values, request } = parseArguments(argv);
  if (command === 'init') return initializeCommand(values, { initialize, ask, env });
  if (values.actor) validateActor(values.actor);
  const live = command === 'start' || (command === 'check' && values.live);
  const loaded = await loadConfig(values.config, { env, requireSecrets: live });
  if (['backup','restore','recovery-inspect','recovery-preview','recovery-apply','recovery-release-preview','recovery-release-apply'].includes(command)) return maintenanceCommand(command,loaded,values,services);
  if (command === 'check' && !values.live) return { valid: true, mode: 'offline', agent: loaded.config.id, hash: loaded.hash, message: 'Configuration validated; external services have not been checked.' };
  const preparedValues = await operatorValues(command, values, services);
  const runtime = await createRuntime(runtimeSettings(loaded, command, live, env));
  try { return await executeCommand(runtime, command, preparedValues, request); }
  finally { if (runtime.stop) await runtime.stop(); }
}

async function defaultDoctor(filename, settings) {
  const { runDoctor } = await import('./doctor.mjs');
  return runDoctor(filename, settings);
}

async function defaultFormatDoctor(report) {
  const { formatDoctor } = await import('./doctor.mjs');
  return formatDoctor(report);
}

async function doctorCommand(argv, { doctor, formatDoctor, stdout, env }) {
  const { values } = parseArguments(argv);
  const report = await doctor(values.config, { live: Boolean(values.live), env });
  const result = values.json ? JSON.stringify(report, null, 2) : await formatDoctor(report);
  stdout.write(`${result}\n`);
  return report.ready ? 0 : 1;
}

async function defaultHealthProbe(root) {
  const { readHealth } = await import('./control.mjs');
  return readHealth(root);
}

async function healthCommand(argv, {healthProbe = defaultHealthProbe, stdout, env}) {
  const {values} = parseArguments(argv);
  const loaded = await loadConfig(values.config, {env});
  const report = await healthProbe(loaded.config.state_root);
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.live && report.ready ? 0 : 1;
}

function readinessCommand(argv, settings) {
  return argv[0] === 'doctor' ? doctorCommand(argv, settings) : healthCommand(argv, settings);
}

function safeCliError(argv, error) {
  if (argv[0] === 'records-intent') return 'Records intent unavailable. Check action, operator authority and command options.';
  if (argv[0] === 'reconcile-records') return 'Records reconciliation denied. Check private receipt, action, operator authority and command options.';
  if (argv[0]==='backup') return 'Backup could not complete. Stop the daemon and check private paths, configuration and maintenance limits.';
  if (argv[0]==='restore') return 'Restore could not complete. Check the snapshot, fresh private state path, operator attribution and maintenance limits.';
  if (argv[0].startsWith('recovery-')) return 'Recovery command could not complete. Check private stopped state, recovery hold and command options.';
  return argv[0] === 'doctor'
    ? 'Doctor could not complete. Check command options with --help and retry.'
    : error.message;
}

export async function runCli(argv, {
  createRuntime = defaultRuntime, doctor = defaultDoctor, formatDoctor = defaultFormatDoctor,
  initialize, ask, healthProbe, backupState, restoreState,inspectRecovery,readRecoveryPlanFile,previewRecovery,applyRecovery,previewRecoveryRelease,applyRecoveryRelease,parseReceiptFile,
  stdout = process.stdout, stderr = process.stderr, env = process.env,
} = {}) {
  try {
    if (!argv.length || argv[0] === '--help') { stdout.write(help+maintenanceHelp+recoveryHelp+recordsHelp); return 0; }
    if (['doctor', 'health'].includes(argv[0])) return await readinessCommand(argv, { doctor, formatDoctor, healthProbe, stdout, env });
    stdout.write(`${JSON.stringify(await executeArguments(argv, {createRuntime,env,initialize,ask,backupState,restoreState,inspectRecovery,
      readRecoveryPlanFile,previewRecovery,applyRecovery,previewRecoveryRelease,applyRecoveryRelease,parseReceiptFile}),null,2)}\n`);
    return 0;
  } catch (error) {
    // Configuration and runtime boundaries must return safe errors, never response bodies or credentials.
    stderr.write(`Mail Agent: ${safeCliError(argv, error)}\n`);
    return 1;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
