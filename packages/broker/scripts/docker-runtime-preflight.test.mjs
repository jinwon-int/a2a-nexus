import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkComposeText,
  checkContainerInspect,
  checkLiveNetworks,
  checkServiceName,
} from './docker-runtime-preflight.mjs';

const validCompose = `services:
  a2a-broker:
    container_name: \${SERVICE_NAME:-a2a-broker}
    environment:
      HOST: 0.0.0.0
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - /var/lib/a2a-broker:/var/lib/a2a-broker
networks:
  a2a:
    name: \${SERVICE_NAME:-a2a-broker}-net
`;

describe('docker runtime preflight compose checks', () => {
  it('accepts the required production compose invariants', () => {
    const checks = checkComposeText(validCompose);
    assert.equal(checks.every((check) => check.ok), true, JSON.stringify(checks, null, 2));
  });

  it('accepts the A2A_BROKER_STATE_DIR templated state bind mount', () => {
    const templated = validCompose.replace(
      '      - /var/lib/a2a-broker:/var/lib/a2a-broker\n',
      '      - ${A2A_BROKER_STATE_DIR:-/var/lib/a2a-broker}:/var/lib/a2a-broker\n',
    );
    const checks = checkComposeText(templated);
    const bindCheck = checks.find((check) => check.check === 'state bind mount');
    assert.equal(bindCheck?.ok, true, bindCheck?.detail);
  });

  it('fails clearly when the state bind mount is absent', () => {
    const checks = checkComposeText(validCompose.replace('    volumes:\n      - /var/lib/a2a-broker:/var/lib/a2a-broker\n', ''));
    const bindCheck = checks.find((check) => check.check === 'state bind mount');
    assert.equal(bindCheck?.ok, false);
    assert.match(bindCheck?.detail ?? '', /volumes must include/);
  });

  it('accepts the templated docker network name', () => {
    const checks = checkComposeText(validCompose);
    const networkCheck = checks.find((check) => check.check === 'compose network name');
    assert.ok(networkCheck, 'compose network name check must exist');
    assert.equal(networkCheck.ok, true, networkCheck.detail);
  });

  it('fails when the network name is no longer the single validated template', () => {
    const drifted = validCompose.replace(
      'name: ${SERVICE_NAME:-a2a-broker}-net',
      'name: ${SERVICE_NAME}',
    );
    const checks = checkComposeText(drifted);
    const networkCheck = checks.find((check) => check.check === 'compose network name');
    assert.equal(networkCheck?.ok, false);
    assert.match(networkCheck?.detail ?? '', /network name/);
  });
});

describe('docker runtime preflight SERVICE_NAME sanity', () => {
  it('accepts safe service names and the unset default', () => {
    for (const value of [undefined, '', 'a2a-broker', 'broker-alpha', 'broker_beta.net']) {
      const check = checkServiceName(value);
      assert.equal(check.ok, true, `${String(value)}: ${check.detail}`);
    }
  });

  it('fails closed on the vps7 env-dump shape', () => {
    const envDump = 'A2A_BROKER_EDGE_SECRET=x\nA2A_BROKER_REVISION=abc123\n';
    for (const value of [envDump, 'a b', 'a\tb', 'a\nb', '-leading-dash', '.leading-dot', 'a'.repeat(64)]) {
      const check = checkServiceName(value);
      assert.equal(check.ok, false, `${JSON.stringify(value).slice(0, 40)} must be rejected`);
      assert.match(check.detail, /SERVICE_NAME/);
    }
  });
});

describe('docker runtime preflight live network checks', () => {
  it('accepts the expected network for the default service name', () => {
    const check = checkLiveNetworks({ 'a2a-broker-net': {} }, {});
    assert.equal(check.ok, true, check.detail);
  });

  it('accepts the network derived from the container SERVICE_NAME', () => {
    const check = checkLiveNetworks({ 'edge-broker-net': {} }, { SERVICE_NAME: 'edge-broker' });
    assert.equal(check.ok, true, check.detail);
  });

  it('reproduces the vps7 defect: an env dump is not a valid network name', () => {
    const envDumpNet = 'A2A_BROKER_EDGE_SECRET=x\nA2A_BROKER_REVISION=abc123';
    const check = checkLiveNetworks({ [envDumpNet]: {} }, {});
    assert.equal(check.ok, false);
    assert.match(check.detail, /unsafe docker network name/i);
  });

  it('fails when the expected service network is not attached', () => {
    const check = checkLiveNetworks({ 'some-other-net': {} }, { SERVICE_NAME: 'a2a-broker' });
    assert.equal(check.ok, false);
    assert.match(check.detail, /expected network a2a-broker-net/);
  });

  it('fails when the container has no network attached', () => {
    const check = checkLiveNetworks({}, {});
    assert.equal(check.ok, false);
    assert.match(check.detail, /no docker network attached/);
  });

  it('live container inspect carries the network name check', () => {
    const base = {
      Name: '/a2a-broker',
      Config: { Env: ['HOST=0.0.0.0'] },
      HostConfig: { PortBindings: { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '8787' }] } },
      Mounts: [{ Source: '/var/lib/a2a-broker', Destination: '/var/lib/a2a-broker' }],
      State: { Health: { Status: 'healthy' } },
    };
    const bad = checkContainerInspect(
      { ...base, NetworkSettings: { Networks: { 'a b c': {} } } },
      'a2a-broker',
    );
    const badCheck = bad.find((check) => check.check === 'live network name');
    assert.equal(badCheck?.ok, false);

    const good = checkContainerInspect(
      { ...base, NetworkSettings: { Networks: { 'a2a-broker-net': {} } } },
      'a2a-broker',
    );
    const goodCheck = good.find((check) => check.check === 'live network name');
    assert.equal(goodCheck?.ok, true, goodCheck?.detail);
  });
});
