export function maintenanceLimits({maxBytes=1_073_741_824,timeoutMs=300_000}={}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>17_179_869_184) throw new Error('Maintenance byte limit must be an integer from 1 to 17179869184.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>600_000) throw new Error('Maintenance timeout must be an integer from 1 to 600000 milliseconds.');
  return {maxBytes,timeoutMs};
}
