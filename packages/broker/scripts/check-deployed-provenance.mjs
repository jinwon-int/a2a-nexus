#!/usr/bin/env node
/**
 * #1772: verify that a *running* broker reports the provenance of the image it
 * is actually running.
 *
 * `scripts/check-build-revision.mjs` (#1766) guards the build: it refuses to
 * bake a revision label that git can prove wrong. Nothing guarded the other
 * end. `docker-compose.yml` injects the deployment host's `.env` over the
 * image's own ENV via `env_file:`, so a stale line there could make
 * `/health.build.revision` advertise a commit the image was never built from
 * while the image label stayed correct. That is not hypothetical — two live
 * brokers were observed disagreeing at the same time:
 *
 *   - one reported a revision a month older than the image it was running,
 *     while that image's label was correct the whole time;
 *   - the other disagreed three ways at once — label, reported revision and
 *     image tag each named a different commit, spanning four days.
 *
 * Both were invisible to label-only verification, because the label was right.
 * This script compares all three surfaces on a live container and fails closed
 * when they disagree.
 *
 * Usage:
 *   node scripts/check-deployed-provenance.mjs --container <container-name>
 *   node scripts/check-deployed-provenance.mjs --container a2a-broker --json
 *
 * The edge secret is read from the container's own environment and used only
 * as a request header. It is never printed, logged, or passed as an argument.
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

const LABEL_REVISION = 'org.opencontainers.image.revision';
const LABEL_CREATED = 'org.opencontainers.image.created';
const LABEL_VERIFIED = 'dev.a2a.image.revision-verified';
const SECRET_ENV_KEYS = ['BROKER_EDGE_SECRET', 'EDGE_SECRET'];

/**
 * Compare the three provenance surfaces of a running deployment.
 *
 * Pure so it can be tested without Docker. `undefined` means "not observed";
 * an absent surface is reported as a gap, never silently treated as agreement.
 *
 * @param {{
 *   container?: string,
 *   labelRevision?: string,
 *   envRevision?: string,
 *   healthRevision?: string,
 *   labelCreated?: string,
 *   healthBuiltAt?: string,
 *   healthImageTag?: string,
 *   revisionVerified?: string,
 * }} observed
 * @returns {{ ok: boolean, findings: Array<{severity: 'error'|'warning', code: string, message: string}> }}
 */
export function evaluateDeployedProvenance(observed) {
  const findings = [];
  const add = (severity, code, message) => findings.push({ severity, code, message });

  const { labelRevision, envRevision, healthRevision } = observed;

  if (!labelRevision) {
    add('error', 'label_missing', `image has no ${LABEL_REVISION} label; provenance cannot be verified`);
  }
  if (!healthRevision) {
    add('error', 'health_unreadable', 'could not read /health.build.revision from the running broker');
  }

  // The invariant: what the broker reports must be what the image was built from.
  if (labelRevision && healthRevision && labelRevision !== healthRevision) {
    add(
      'error',
      'health_label_mismatch',
      `/health.build.revision=${healthRevision} does not match the image label ${LABEL_REVISION}=${labelRevision}. ` +
        'The broker is advertising a commit its image was not built from.',
    );
  }

  // Root cause of the mismatch class: a host env var shadowing the image.
  if (labelRevision && envRevision && labelRevision !== envRevision) {
    const severity = healthRevision === labelRevision ? 'warning' : 'error';
    add(
      severity,
      'env_shadows_image',
      `container env A2A_BROKER_REVISION=${envRevision} contradicts the image label ${labelRevision}` +
        (severity === 'warning'
          ? ' (ignored by the broker since #1772, but the stale value should be removed from the deployment .env)'
          : ' and is what the broker is reporting — this is the #1772 shadowing defect'),
    );
  }

  if (observed.healthImageTag && labelRevision) {
    const shortLabel = labelRevision.slice(0, 12);
    // Tags conventionally embed a short sha; only flag when one is present and disagrees.
    const embedded = /([0-9a-f]{7,40})/i.exec(observed.healthImageTag)?.[1];
    if (embedded && !labelRevision.startsWith(embedded) && !embedded.startsWith(shortLabel)) {
      add(
        'warning',
        'image_tag_mismatch',
        `/health.build.image.tag=${observed.healthImageTag} embeds ${embedded}, which is not the built revision ${shortLabel}`,
      );
    }
  }

  if (observed.revisionVerified !== undefined && observed.revisionVerified !== 'true') {
    add(
      'warning',
      'unverified_build',
      `image label ${LABEL_VERIFIED}=${observed.revisionVerified}: this image was built without the #1766 preflight, ` +
        'so its own label was never checked against its source',
    );
  }

  return { ok: !findings.some((f) => f.severity === 'error'), findings };
}

function parseArgs(argv) {
  const options = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === '--container') options.container = next();
    else if (arg === '--health-url') options.healthUrl = next();
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function dockerInspect(container, format) {
  return execFileSync('docker', ['inspect', container, '--format', format], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readContainerEnv(container) {
  const raw = dockerInspect(container, '{{range .Config.Env}}{{println .}}{{end}}');
  const env = new Map();
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) env.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return env;
}

function resolveHealthUrl(container, override) {
  if (override) return override;
  const ports = dockerInspect(container, '{{json .NetworkSettings.Ports}}');
  const parsed = JSON.parse(ports || '{}');
  for (const [, bindings] of Object.entries(parsed)) {
    const binding = Array.isArray(bindings) ? bindings[0] : undefined;
    if (binding?.HostPort) {
      const host = binding.HostIp && binding.HostIp !== '0.0.0.0' && binding.HostIp !== '::' ? binding.HostIp : '127.0.0.1';
      return `http://${host}:${binding.HostPort}/health`;
    }
  }
  throw new Error('could not derive a health URL from published ports; pass --health-url');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(2);
  }

  if (options.help || !options.container) {
    console.error('usage: check-deployed-provenance.mjs --container <name> [--health-url <url>] [--json]');
    process.exit(options.help ? 0 : 2);
  }

  const observed = { container: options.container };
  try {
    observed.labelRevision = dockerInspect(options.container, `{{index .Config.Labels "${LABEL_REVISION}"}}`) || undefined;
    observed.labelCreated = dockerInspect(options.container, `{{index .Config.Labels "${LABEL_CREATED}"}}`) || undefined;
    const verified = dockerInspect(options.container, `{{index .Config.Labels "${LABEL_VERIFIED}"}}`);
    observed.revisionVerified = verified === '<no value>' || verified === '' ? undefined : verified;
  } catch (error) {
    console.error(`docker inspect failed for ${options.container}: ${String(error.message ?? error).split('\n')[0]}`);
    process.exit(2);
  }

  const env = readContainerEnv(options.container);
  observed.envRevision = env.get('A2A_BROKER_REVISION') || undefined;

  const secret = SECRET_ENV_KEYS.map((key) => env.get(key)).find((value) => value);
  try {
    const url = resolveHealthUrl(options.container, options.healthUrl);
    const res = await fetch(url, {
      headers: secret ? { 'x-a2a-edge-secret': secret } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = await res.json();
      observed.healthRevision = body?.build?.revision;
      observed.healthBuiltAt = body?.build?.builtAt;
      observed.healthImageTag = body?.build?.image?.tag;
    }
  } catch {
    // Left undefined; evaluate() reports the gap rather than guessing.
  }

  const result = evaluateDeployedProvenance(observed);

  if (options.json) {
    // `observed` deliberately carries no secret-bearing field.
    console.log(JSON.stringify({ ...result, observed }, null, 2));
  } else {
    console.log(`container:        ${options.container}`);
    console.log(`image label:      ${observed.labelRevision ?? '(none)'}${observed.labelCreated ? `  created=${observed.labelCreated}` : ''}`);
    console.log(`container env:    ${observed.envRevision ?? '(none)'}`);
    console.log(`/health reports:  ${observed.healthRevision ?? '(unreadable)'}`);
    if (observed.healthImageTag) console.log(`/health image.tag: ${observed.healthImageTag}`);
    console.log('');
    if (result.findings.length === 0) {
      console.log('provenance ok: the running broker reports the revision its image was built from.');
    } else {
      for (const finding of result.findings) {
        console.log(`[${finding.severity}] ${finding.code}: ${finding.message}`);
      }
    }
  }

  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  await main();
}
