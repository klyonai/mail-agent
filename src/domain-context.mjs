import { address, digest, policyDigest } from './policy.mjs';

export const DOMAIN_CONTEXT_KEY = 'mail-agent/actor-context';
export const DOMAIN_CONTEXT_CAPABILITY = Object.freeze({ version: 1 });

const MAX_TTL_MS = 5 * 60 * 1000;
const hashPattern = /^[a-f0-9]{64}$/;
const qualifiedTool = /^[a-z][a-z0-9_-]{0,63}\.[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const emailPattern = /^[^\s@<>]{1,128}@[A-Za-z0-9.-]{1,253}$/;
const contextKeys = ['version', 'agentId', 'mailbox', 'actor', 'provenance', 'tool', 'argsHash', 'operationId',
  'policyHash', 'issuedAt', 'expiresAt', 'authorization', 'approval'];
const provenanceKeys = ['source', 'messageIdHash', 'conversationIdHash', 'authProfile'];
const approvalKeys = ['id', 'actor', 'origin', 'reasonHash', 'expiresAt'];

export class DomainContextError extends Error {
  constructor() {
    super('Domain actor context is invalid.');
    this.name = 'DomainContextError';
    this.code = 'DOMAIN_CONTEXT_INVALID';
  }
}

function invalid() { throw new DomainContextError(); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string') || ownKeys.length !== keys.length
    || ownKeys.some(key => !keys.includes(key))) invalid();
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function text(value, max = 256) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function epoch(value) { return Number.isSafeInteger(value) && value >= 0; }
function validEmail(value) { return typeof value === 'string' && emailPattern.test(value) && address(value) === value; }
function validHash(value) { return typeof value === 'string' && hashPattern.test(value); }

function safeArgs(args) {
  const seen = new Set();
  let nodes = 0;
  function clone(value, depth) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || depth > 16 || ++nodes > 2000 || seen.has(value)) invalid();
    seen.add(value);
    const result = Array.isArray(value) ? cloneArray(value, depth, clone) : cloneObject(value, depth, clone);
    seen.delete(value);
    return result;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalid();
  const cloned = clone(args, 0);
  let serialized;
  try { serialized = JSON.stringify(cloned); } catch { invalid(); }
  if (!serialized || Buffer.byteLength(serialized) > 65_536) invalid();
  let parsed;
  try { parsed = JSON.parse(serialized); } catch { invalid(); }
  return parsed;
}

function cloneArray(value, depth, clone) {
  if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).some(key => typeof key === 'symbol')) invalid();
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    result.push(clone(descriptor.value, depth + 1));
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
  return result;
}

function cloneObject(value, depth, clone) {
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    result[key] = clone(descriptor.value, depth + 1);
  }
  return result;
}

function cloneAndValidate(value, { now = Date.now(), agentId, mailbox, tool, args, connection } = {}) {
  const context = record(value, contextKeys);
  const provenance = record(context.provenance, provenanceKeys);
  const approval = context.approval === null ? null : record(context.approval, approvalKeys);
  validateContextFields(context, now);
  validateProvenance(provenance);
  validateApproval(context, approval, now);
  validateExpected(context, { agentId, mailbox, tool, args, connection });
  return Object.freeze({ ...context, provenance: Object.freeze(provenance), approval: approval && Object.freeze(approval) });
}

function validateContextFields(context, now) {
  if (!validContextIdentity(context) || !validContextTime(context, now) || !['automatic', 'approval'].includes(context.authorization)) invalid();
}

function validContextIdentity(context) {
  return context.version === 1 && text(context.agentId, 64) && validEmail(context.mailbox)
    && validEmail(context.actor) && qualifiedTool.test(context.tool) && validHash(context.argsHash)
    && validHash(context.operationId) && validHash(context.policyHash);
}

function validContextTime(context, now) {
  return Number.isSafeInteger(now) && now >= 0 && epoch(context.issuedAt) && epoch(context.expiresAt)
    && context.issuedAt <= now && context.expiresAt > now && context.expiresAt <= context.issuedAt + MAX_TTL_MS;
}

function validateProvenance(provenance) {
  if (provenance.source !== 'verified-mail-envelope' || !validHash(provenance.messageIdHash)
    || !validHash(provenance.conversationIdHash)
    || !['exchange-authenticated', 'exchange-internal'].includes(provenance.authProfile)) invalid();
}

function validateApproval(context, approval, now) {
  if (context.authorization === 'approval' && !approval) invalid();
  if (context.authorization === 'automatic' && approval) invalid();
  if (!approval) return;
  if (!validApprovalRecord(approval) || approval.id !== context.operationId || approval.expiresAt <= now
    || approval.expiresAt < context.expiresAt) invalid();
}

function validApprovalRecord(approval) {
  return validHash(approval.id) && validEmail(approval.actor) && approval.origin === 'local-operator'
    && validHash(approval.reasonHash) && epoch(approval.expiresAt);
}

function validateExpected(context, { agentId, mailbox, tool, args, connection }) {
  if (agentId !== undefined && context.agentId !== agentId) invalid();
  if (mailbox !== undefined && context.mailbox !== address(mailbox)) invalid();
  if (tool !== undefined && context.tool !== tool) invalid();
  if (args !== undefined && context.argsHash !== digest(safeArgs(args))) invalid();
  if (connection !== undefined && context.tool.split('.', 1)[0] !== connection) invalid();
}

export function domainContextEnabled(config, qualifiedToolName) {
  if (typeof qualifiedToolName !== 'string' || !qualifiedTool.test(qualifiedToolName)) return false;
  const connection = qualifiedToolName.slice(0, qualifiedToolName.indexOf('.'));
  const settings = config?.mcp?.[connection];
  return settings?.transport === 'stdio' && settings.actor_context === 'mail-agent-v1';
}

export function createDomainContext({ run, call, actionKey, config, authorization, clock = Date.now, approval = null } = {}) {
  try {
    const now = clock();
    const { args, expiresAt, validatedApproval } = contextInputs({ run, call, actionKey, config, authorization, approval, now });
    const { mail } = run;
    const authProfile = config.mailbox.sender_authentication.mode;
    return cloneAndValidate({
      version: 1,
      agentId: config.id,
      mailbox: address(config.mailbox.address),
      actor: address(mail.sender),
      provenance: { source: 'verified-mail-envelope', messageIdHash: digest(mail.id),
        conversationIdHash: digest(mail.conversationId), authProfile },
      tool: call.name,
      argsHash: digest(args),
      operationId: actionKey,
      policyHash: policyDigest(config),
      issuedAt: now,
      expiresAt,
      authorization,
      approval: validatedApproval,
    }, { now, agentId: config.id, mailbox: config.mailbox.address, tool: call.name, args,
      connection: call.name.split('.', 1)[0] });
  } catch { invalid(); }
}

function contextInputs({ run, call, actionKey, config, authorization, approval, now }) {
  const mail = run?.mail;
  const authProfile = config?.mailbox?.sender_authentication?.mode;
  const policy = config?.policy?.tools?.[call?.name];
  if (!validRequestEnvelope(run, mail, config, authProfile, now) || !validCallAuthorization(config, call, actionKey, policy, authorization)) invalid();
  const args = safeArgs(call.args);
  const expiresAt = expiry(run, config, now, authorization, approval, actionKey);
  const validatedApproval = authorization === 'approval' ? normalizedApproval(approval) : null;
  return { args, expiresAt, validatedApproval };
}

function validRequestEnvelope(run, mail, config, authProfile, now) {
  return validClock(now) && Boolean(mail) && mail.authenticated === true && validMailIdentity(mail)
    && text(config?.id, 64) && validMailbox(config) && validAuthProfile(authProfile);
}

function validClock(value) { return Number.isSafeInteger(value) && value >= 0; }
function validMailIdentity(mail) { return text(mail.id, 2048) && text(mail.conversationId, 2048) && validEmail(address(mail.sender)); }
function validMailbox(config) { return text(config?.mailbox?.address, 254) && validEmail(address(config.mailbox.address)); }

function validCallAuthorization(config, call, actionKey, policy, authorization) {
  return domainContextEnabled(config, call?.name) && validHash(actionKey) && validAuthorization(policy, authorization);
}

function validAuthorization(policy, authorization) {
  return Boolean(policy) && policy.authorization === authorization && ['automatic', 'approval'].includes(authorization)
    && !(policy.effect === 'write' && authorization === 'automatic');
}

function validAuthProfile(value) { return ['exchange-authenticated', 'exchange-internal'].includes(value); }

function expiry(run, config, now, authorization, approval, actionKey) {
  if (!validRunExpiry(run, config)) invalid();
  const contentExpiry = run.createdAt + config.retention.content_hours * 3_600_000;
  let expiresAt = Math.min(now + MAX_TTL_MS, contentExpiry);
  if (authorization === 'approval') {
    const candidate = validConfiguredApproval(approval, config, actionKey, now);
    expiresAt = Math.min(expiresAt, candidate.expiresAt);
  } else if (approval !== null) invalid();
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) invalid();
  return expiresAt;
}

function validRunExpiry(run, config) {
  return Number.isSafeInteger(run.createdAt) && run.createdAt >= 0
    && Number.isSafeInteger(config.retention?.content_hours) && config.retention.content_hours > 0;
}

function validConfiguredApproval(approval, config, actionKey, now) {
  const candidate = normalizedApproval(approval);
  if (candidate.id !== actionKey || !config.policy.approvers.map(address).includes(candidate.actor)
    || candidate.expiresAt <= now) invalid();
  return candidate;
}

function normalizedApproval(value) {
  const approval = record(value, approvalKeys);
  if (!validHash(approval.id) || !validEmail(approval.actor) || approval.origin !== 'local-operator'
    || !validHash(approval.reasonHash) || !epoch(approval.expiresAt)) invalid();
  return approval;
}

export function validateDomainContext(value, options = {}) {
  try { return cloneAndValidate(value, options); }
  catch { invalid(); }
}
