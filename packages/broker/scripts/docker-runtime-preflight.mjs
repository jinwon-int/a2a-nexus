#!/usr/bin/env node
// Docker Compose runtime preflight for the production A2A Broker service.
// Dry-run mode is CI-safe and validates repo-local compose invariants only.
// Docker network naming is validated fail-closed end to end: an env dump or
// other unsafe value in SERVICE_NAME must never reach a docker network name
// (vps7 2026-10-02 incident - a whole env file became the network name).

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import process from 'node:process';

const execFileAsync = promisify(execFile);

export const REQUIRED = Object.freeze({
  serviceName: 'a2a-broker',
  containerName: 'a2a-broker',
  hostPublish: '127.0.0.1:8787:8787',
  containerHost: '0.0.0.0',
  stateBind: '/var/lib/a2a-broker:/var/lib/a2a-broker',
  stateBindTemplate: '${A2A_BROKER_STATE_DIR:-/var/lib/a2a-broker}:/var/lib/a2a-broker',
  legacyService: 'a2a-broker.service',
  networkNameTemplate: '${SERVICE_NAME:-a2a-broker}-net',
  networkName: 'a2a-broker-net',
});

// Docker names share one conservative character set: no whitespace (a whole
// env dump pasted into SERVICE_NAME is the vps7 2026-10-02 incident shape and
// must fail closed before it reaches `docker network create`), no shell
// metacharacters, no leading separator, 63-char DNS-label cap.
export const SAFE_DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

export function isSafeDockerName(value) {
  return typeof value === 'string' && SAFE_DOCKER_NAME.test(value);
}

export function checkServiceName(serviceName) {
  if (serviceName === undefined || serviceName === '') {
    return ok('SERVICE_NAME sanity', `SERVICE_NAME unset; compose default ${REQUIRED.serviceName} applies`);
  }
  return isSafeDockerName(serviceName)
    ? ok('SERVICE_NAME sanity', `SERVICE_NAME=${serviceName}`)
    : fail(
        'SERVICE_NAME sanity',
        `SERVICE_NAME must match ${SAFE_DOCKER_NAME} (no whitespace, newlines, or '=', 1-63 chars); ` +
          `got ${JSON.stringify(serviceName).slice(0, 80)} - an env dump in SERVICE_NAME becomes the docker network name`,
      );
}

export function checkLiveNetworks(networks, env) {
  const attached = Object.keys(networks || {});
  if (attached.length === 0) {
    return fail('live network name', 'container has no docker network attached');
  }
  const unsafe = attached.filter((name) => !isSafeDockerName(name));
  if (unsafe.length > 0) {
    return fail(
      'live network name',
      `unsafe docker network name(s) ${JSON.stringify(unsafe)} - recreate from ${REQUIRED.networkNameTemplate} with a safe SERVICE_NAME`,
    );
  }
  const serviceName = env?.SERVICE_NAME || REQUIRED.serviceName;
  const expected = `${serviceName}-net`;
  if (!attached.includes(expected)) {
    return fail('live network name', `expected network ${expected} (SERVICE_NAME=${serviceName}), attached: ${attached.join(', ')}`);
  }
  return ok('live network name', `attached: ${attached.join(', ')}`);
}

function ok(check, detail) {
  return { ok: true, check, detail };
}

function fail(check, detail) {
  return { ok: false, check, detail };
}

function hasComposeMapping(text, key, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${key}:\\s*(?:["']?${escaped}["']?)`, 'm').test(text);
}

function hasComposeListItem(text, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*-\\s*["']?${escaped}["']?\\s*$`, 'm').test(text);
}

export function checkComposeText(text, composePath = 'docker-compose.yml') {
  const checks = [];

  checks.push(
    /^services:\s*$/m.test(text) && new RegExp(`^  ${REQUIRED.serviceName}:\\s*$`, 'm').test(text)
      ? ok('compose service', `${composePath} defines services.${REQUIRED.serviceName}`)
      : fail('compose service', `${composePath} must define services.${REQUIRED.serviceName}`),
  );

  checks.push(
    hasComposeMapping(text, 'container_name', '${SERVICE_NAME:-a2a-broker}') || hasComposeMapping(text, 'container_name', REQUIRED.containerName)
      ? ok('container name', 'container_name resolves to a2a-broker by default')
      : fail('container name', 'container_name must default to a2a-broker'),
  );

  checks.push(
    hasComposeMapping(text, 'name', REQUIRED.networkNameTemplate) || hasComposeMapping(text, 'name', REQUIRED.networkName)
      ? ok('compose network name', `network name stays ${REQUIRED.networkNameTemplate} (single validated SERVICE_NAME source)`)
      : fail('compose network name', `network name must stay ${REQUIRED.networkNameTemplate} (networks.<alias>.name); arbitrary expansions bypass SERVICE_NAME validation`),
  );

  checks.push(
    text.includes(`"${REQUIRED.hostPublish}"`) || text.includes(`'${REQUIRED.hostPublish}'`) || text.includes(`- ${REQUIRED.hostPublish}`)
      ? ok('loopback publish', `ports includes ${REQUIRED.hostPublish}`)
      : fail('loopback publish', `ports must include ${REQUIRED.hostPublish}`),
  );

  checks.push(
    hasComposeMapping(text, 'HOST', REQUIRED.containerHost)
      ? ok('container HOST', `HOST=${REQUIRED.containerHost}`)
      : fail('container HOST', `environment must set HOST=${REQUIRED.containerHost}`),
  );

  checks.push(
    text.includes(REQUIRED.stateBind) || hasComposeListItem(text, REQUIRED.stateBindTemplate)
      ? ok('state bind mount', `volumes includes ${REQUIRED.stateBindTemplate} (or the literal ${REQUIRED.stateBind})`)
      : fail('state bind mount', `volumes must include ${REQUIRED.stateBindTemplate} or ${REQUIRED.stateBind}`),
  );

  return checks;
}

function parseArgs(argv) {
  const args = new Set(argv);
  return {
    dryRun: args.has('--dry-run'),
    json: args.has('--json'),
    composePath: argv.find((arg) => arg.startsWith('--compose='))?.slice('--compose='.length) || 'docker-compose.yml',
    container: argv.find((arg) => arg.startsWith('--container='))?.slice('--container='.length) || REQUIRED.containerName,
  };
}

async function dockerInspect(container) {
  const { stdout } = await execFileAsync('docker', ['inspect', container], { maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(`unexpected docker inspect payload for ${container}`);
  return parsed[0];
}

export function checkContainerInspect(inspect, container) {
  const env = Object.fromEntries((inspect.Config?.Env || []).map((entry) => {
    const idx = entry.indexOf('=');
    return idx === -1 ? [entry, ''] : [entry.slice(0, idx), entry.slice(idx + 1)];
  }));
  const portBindings = inspect.HostConfig?.PortBindings?.['8787/tcp'] || [];
  const mounts = inspect.Mounts || [];

  return [
    inspect.Name === `/${container}`
      ? ok('live container name', inspect.Name)
      : fail('live container name', `expected /${container}, got ${inspect.Name || 'unknown'}`),
    env.HOST === REQUIRED.containerHost
      ? ok('live HOST', `HOST=${env.HOST}`)
      : fail('live HOST', `expected HOST=${REQUIRED.containerHost}, got ${env.HOST || 'unset'}`),
    portBindings.some((binding) => binding.HostIp === '127.0.0.1' && binding.HostPort === '8787')
      ? ok('live loopback publish', '8787/tcp is published on 127.0.0.1:8787')
      : fail('live loopback publish', `expected 127.0.0.1:8787 binding, got ${JSON.stringify(portBindings)}`),
    mounts.some((mount) => mount.Source === '/var/lib/a2a-broker' && mount.Destination === '/var/lib/a2a-broker')
      ? ok('live state bind mount', REQUIRED.stateBind)
      : fail('live state bind mount', `expected ${REQUIRED.stateBind}`),
    inspect.State?.Health?.Status === 'healthy'
      ? ok('live health', 'container health is healthy')
      : fail('live health', `expected healthy, got ${inspect.State?.Health?.Status || inspect.State?.Status || 'unknown'}`),
    checkLiveNetworks(inspect.NetworkSettings?.Networks, env),
  ];
}

async function checkLegacyService() {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-enabled', REQUIRED.legacyService]);
    const state = stdout.trim();
    return state === 'disabled'
      ? ok('legacy service disabled', `${REQUIRED.legacyService} is disabled`)
      : fail('legacy service disabled', `${REQUIRED.legacyService} is ${state}`);
  } catch (error) {
    const state = (error.stdout || '').trim();
    if (state === 'disabled') return ok('legacy service disabled', `${REQUIRED.legacyService} is disabled`);
    if (state === 'not-found') return ok('legacy service disabled', `${REQUIRED.legacyService} is not installed`);
    return fail('legacy service disabled', `${REQUIRED.legacyService} is ${state || 'unknown'} (systemctl exit ${error.code ?? 'unknown'})`);
  }
}

async function checkLegacyInactive() {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', REQUIRED.legacyService]);
    const state = stdout.trim();
    return state === 'inactive'
      ? ok('legacy service inactive', `${REQUIRED.legacyService} is inactive`)
      : fail('legacy service inactive', `${REQUIRED.legacyService} is ${state}`);
  } catch (error) {
    const state = (error.stdout || '').trim();
    if (state === 'inactive' || state === 'unknown' || state === 'failed') {
      return state === 'failed'
        ? fail('legacy service inactive', `${REQUIRED.legacyService} is failed; clear/disable before release`)
        : ok('legacy service inactive', `${REQUIRED.legacyService} is ${state}`);
    }
    return fail('legacy service inactive', `${REQUIRED.legacyService} is ${state || 'unknown'} (systemctl exit ${error.code ?? 'unknown'})`);
  }
}

function printHuman(checks, dryRun) {
  console.log(`A2A Broker Docker runtime preflight (${dryRun ? 'dry-run' : 'live'})`);
  for (const result of checks) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.check}: ${result.detail}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const composeText = await readFile(options.composePath, 'utf8');
  const checks = checkComposeText(composeText, options.composePath);
  checks.push(checkServiceName(process.env.SERVICE_NAME));

  if (!options.dryRun) {
    try {
      checks.push(...checkContainerInspect(await dockerInspect(options.container), options.container));
    } catch (error) {
      checks.push(fail('docker inspect', error.message));
    }
    checks.push(await checkLegacyService());
    checks.push(await checkLegacyInactive());
  }

  if (options.json) {
    console.log(JSON.stringify({ dryRun: options.dryRun, checks }, null, 2));
  } else {
    printHuman(checks, options.dryRun);
  }

  process.exit(checks.every((result) => result.ok) ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`fatal: ${error.message}`);
    process.exit(2);
  });
}
