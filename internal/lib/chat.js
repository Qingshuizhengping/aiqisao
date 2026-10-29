import { createChatDomain } from './chat-service.js';
import { createChatRunner } from './chat-runner.js';
import { createChatRouter } from './chat-routes.js';

// Stable composition boundary used by the server and existing callers.
export function createChatService({ db, config, provider, memory, knowledge }) {
    const domain = createChatDomain({ db, config, memory, knowledge });
    const runner = createChatRunner({ db, config, provider, memory, domain });
    const router = createChatRouter({ db, config, domain, runner });
    return { router, start: runner.start, stop: runner.stop, snapshot: runner.snapshot, health: runner.health };
}
