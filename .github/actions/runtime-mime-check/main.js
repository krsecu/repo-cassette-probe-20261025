'use strict';

const crypto = require('node:crypto');

async function main() {
  const token = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  const encodedMime = process.env.PROBE_MIME_B64;
  if (!token || !resultsUrl || !encodedMime) throw new Error('missing_context');

  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  const scopes = Array.isArray(claims.scp) ? claims.scp : String(claims.scp || '').split(' ');
  const resultScope = scopes.find(scope => String(scope).startsWith('Actions.Results:'));
  if (!resultScope) throw new Error('missing_scope');
  const [, run, job] = resultScope.split(':');
  if (!run || !job) throw new Error('invalid_scope');

  const mime = Buffer.from(encodedMime, 'base64').toString('utf8');
  const origin = new URL(resultsUrl).origin;
  const name = `runtime-check-${process.env.GITHUB_RUN_ID}`;
  const common = {workflow_run_backend_id: run, workflow_job_run_backend_id: job};
  const service = 'github.actions.results.api.v1.ArtifactService';

  async function rpc(method, body) {
    const response = await fetch(`${origin}/twirp/${service}/${method}`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    let data = {};
    try { data = await response.json(); } catch { /* Response body is never logged. */ }
    return {status: response.status, data};
  }

  const created = await rpc('CreateArtifact', {
    ...common, name, version: 7, mime_type: mime,
  });
  const code = typeof created.data.code === 'string' && /^[a-z_]+$/i.test(created.data.code)
    ? created.data.code : 'none';
  console.log(`CREATE_STATUS=${created.status}`);
  console.log(`CREATE_CODE=${code}`);
  if (created.status !== 200 || created.data.ok !== true) return;

  const uploadUrl = created.data.signedUploadUrl || created.data.signed_upload_url;
  if (!uploadUrl) throw new Error('missing_upload_url');
  const body = Buffer.from([0]);
  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': '1',
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-version': '2023-11-03',
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (upload.status !== 201) throw new Error('upload_failed');
  const hash = `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
  const finalized = await rpc('FinalizeArtifact', {...common, name, size: '1', hash});
  if (finalized.status !== 200) throw new Error('finalize_failed');
}

main().catch(error => {
  const allowed = new Set([
    'missing_context', 'missing_scope', 'invalid_scope', 'missing_upload_url',
    'upload_failed', 'finalize_failed',
  ]);
  const code = error instanceof Error && allowed.has(error.message) ? error.message : 'unexpected';
  console.error(`PROBE_ERROR=${code}`);
  process.exitCode = 1;
});
