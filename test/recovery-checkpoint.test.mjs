import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGraphCheckpoint } from '../src/graph.mjs';

const mailbox = { address: 'agent@example.test' };
const cursor = JSON.stringify({ url: 'https://graph.microsoft.com/v1.0/users/agent%40example.test/mailFolders/inbox/messages/delta?$deltatoken=synthetic', initialComplete: true });

test('completed recovery checkpoints are validated offline against the configured Graph mailbox', () => {
  assert.equal(validateGraphCheckpoint(mailbox, cursor), cursor);
  const alternate = cursor.replace('/mailFolders/inbox/', "/mailFolders('inbox')/");
  assert.equal(validateGraphCheckpoint(mailbox, alternate), alternate);
  for (const value of [null, '', 'invalid', cursor.replace('true', 'false'), cursor.replace('agent%40example.test', 'other%40example.test'),
    cursor.replace('graph.microsoft.com', 'attacker.example.test'), cursor.replace('/inbox/', '/sentitems/'), 'x'.repeat(65537)]) {
    assert.throws(() => validateGraphCheckpoint(mailbox, value), error => error.code === 'invalid-cursor');
  }
});
