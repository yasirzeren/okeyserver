'use strict';

function healthPayload(env = process.env) {
  const revision = env.RENDER_GIT_COMMIT;
  return { ok: true, ...(typeof revision === 'string' && revision.length === 40 && /^[a-f0-9]{40}$/i.test(revision)
    ? { buildRevision: revision.toLowerCase() } : {}) };
}

module.exports = { healthPayload };
