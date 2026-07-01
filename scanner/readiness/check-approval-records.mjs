import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dir = path.join(root, 'fixtures', 'approvals');
const schemaPath = path.join(dir, 'approval-record.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const allowedActions = new Set(schema.properties.action.enum);
const forbiddenKeys = new Set(['approverName', 'approvedBy', 'channel', 'privateChannel', 'telegramDm', 'telegramUser', 'secret', 'token']);
const findings = [];

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /Z$/.test(value);
}

for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'approval-record.schema.json').sort()) {
  const rel = path.join('fixtures', 'approvals', file);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch (err) {
    findings.push({ file: rel, code: 'invalid_json', message: err.message });
    continue;
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) findings.push({ file: rel, code: 'not_object' });
  for (const key of Object.keys(record)) {
    if (!schema.properties[key]) findings.push({ file: rel, code: 'additional_property', key });
    if (forbiddenKeys.has(key) || /(secret|token|password|telegram|channel|approverName|approvedBy)/i.test(key)) findings.push({ file: rel, code: 'forbidden_private_field', key });
  }
  for (const key of schema.required) if (record[key] === undefined) findings.push({ file: rel, code: 'missing_required', key });
  if (!allowedActions.has(record.action)) findings.push({ file: rel, code: 'invalid_action', action: record.action });
  if (record.approverRole !== 'operator') findings.push({ file: rel, code: 'invalid_approver_role' });
  if (!isIsoDate(record.approvedAt)) findings.push({ file: rel, code: 'invalid_approvedAt' });
  if (record.scopeExpiry !== undefined && !isIsoDate(record.scopeExpiry)) findings.push({ file: rel, code: 'invalid_scopeExpiry' });
  if (!Number.isInteger(record.evidenceIssue) || record.evidenceIssue < 1) findings.push({ file: rel, code: 'invalid_evidenceIssue' });
  for (const key of ['target', 'rollbackBoundary']) if (typeof record[key] !== 'string' || record[key].trim() === '') findings.push({ file: rel, code: 'empty_string', key });
}

if (findings.length) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checked: fs.readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'approval-record.schema.json').length }));
