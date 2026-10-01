import {digest,address} from './policy.mjs';

export const mailboxIdentity=config=>digest([config.id,config.mailbox.tenant_id,config.mailbox.client_id,address(config.mailbox.address)]);
