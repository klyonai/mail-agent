import { createDomainContext, domainContextEnabled } from './domain-context.mjs';
import { digest, policyDigest } from './policy.mjs';

export function requireDomainApproval(config, call, policy) {
  if (domainContextEnabled(config, call.name) && policy.effect === 'write' && policy.authorization !== 'approval') {
    throw new Error('Domain mutations require exact approval.');
  }
}

function approvalProjection(run, call, key, config) {
  const grant = run.grants?.[key];
  if (!grant || grant.id !== key || grant.tool !== call.name || digest(grant.args) !== digest(call.args)
    || grant.policyHash !== policyDigest(config)) throw new Error('Domain approval does not match the invocation.');
  return { id: grant.id, actor: grant.actor, origin: 'local-operator', reasonHash: grant.reasonHash, expiresAt: grant.expiresAt };
}

export function domainInvocationContext(run, call, key, config, policy, clock) {
  if (!domainContextEnabled(config, call.name)) return undefined;
  requireDomainApproval(config, call, policy);
  const approval = policy.authorization === 'approval' ? approvalProjection(run, call, key, config) : null;
  return createDomainContext({ run, call, actionKey: key, config, authorization: policy.authorization, clock, approval });
}

export function invocationOptions(signal, context) {
  return context === undefined ? { signal } : { signal, context };
}
