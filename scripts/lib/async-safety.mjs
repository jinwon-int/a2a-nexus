/**
 * Type-aware floating-promise analysis for production TypeScript source.
 *
 * Tests and declarations are excluded from the source bucket. A Promise may be
 * intentionally detached only with an explicit `void`, or handled with
 * `.catch(handler)` / `.then(onFulfilled, onRejected)`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = path.resolve(HERE, '../../packages/broker');
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PACKAGE_ROOT, 'tsconfig.json');

const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

/**
 * realpathSync with per-directory memoization. Non-symlink entries resolve as
 * their (cached) parent directory's realpath plus their own basename — the
 * same result realpathSync would produce, without re-walking the directory
 * chain for every file. Symlinked entries fall back to a full realpathSync so
 * symlink-escape checks keep their exact semantics.
 */
export function createCachedRealpath() {
  const dirCache = new Map();
  const realDir = (dir) => {
    let real = dirCache.get(dir);
    if (real === undefined) {
      real = fs.realpathSync(dir);
      dirCache.set(dir, real);
    }
    return real;
  };
  return (file) => (
    fs.lstatSync(file).isSymbolicLink()
      ? fs.realpathSync(file)
      : path.join(realDir(path.dirname(file)), path.basename(file))
  );
}

export function isProductionSource(fileName, packageRoot = DEFAULT_PACKAGE_ROOT) {
  const relative = normalizePath(path.relative(packageRoot, fileName));
  return (
    relative.startsWith('src/') &&
    /\.(?:ts|mts|cts)$/.test(relative) &&
    !/\.d\.(?:ts|mts|cts)$/.test(relative) &&
    !/\.test\.(?:ts|mts|cts)$/.test(relative)
  );
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isDefinedRejectionHandler(expression) {
  const current = unwrapExpression(expression);
  return !(
    current.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(current) && current.text === 'undefined')
  );
}

function isHandledPromiseCall(expression) {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return false;
  }
  const method = expression.expression.name.text;
  if (method === 'catch') {
    return expression.arguments.length >= 1 && isDefinedRejectionHandler(expression.arguments[0]);
  }
  if (method === 'then') {
    return expression.arguments.length >= 2 && isDefinedRejectionHandler(expression.arguments[1]);
  }
  return false;
}

function typeContainsPromise(type, checker, seen = new Set()) {
  if (seen.has(type)) return false;
  seen.add(type);
  if (checker.getPromisedTypeOfPromise(type)) return true;
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => typeContainsPromise(member, checker, seen));
  }
  return false;
}

function expressionCanFloatPromise(expression, checker) {
  const current = unwrapExpression(expression);
  if (ts.isAwaitExpression(current) || ts.isVoidExpression(current)) return false;
  if (isHandledPromiseCall(current)) return false;

  if (ts.isConditionalExpression(current)) {
    return (
      expressionCanFloatPromise(current.whenTrue, checker) ||
      expressionCanFloatPromise(current.whenFalse, checker)
    );
  }

  if (ts.isBinaryExpression(current)) {
    if (ASSIGNMENT_OPERATORS.has(current.operatorToken.kind)) return false;
    if (
      current.operatorToken.kind === ts.SyntaxKind.CommaToken ||
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return (
        expressionCanFloatPromise(current.left, checker) ||
        expressionCanFloatPromise(current.right, checker)
      );
    }
  }

  return typeContainsPromise(checker.getTypeAtLocation(current), checker);
}

function formatConfigError(error) {
  return ts.flattenDiagnosticMessageText(error.messageText, '\n');
}

export function analyzeProject({
  configPath = DEFAULT_CONFIG_PATH,
  packageRoot = path.dirname(configPath),
} = {}) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(`cannot read TypeScript config: ${formatConfigError(config.error)}`);
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      `invalid TypeScript config: ${parsed.errors.map(formatConfigError).join('; ')}`,
    );
  }

  const realPackageRoot = fs.realpathSync(packageRoot);
  const resolveReal = createCachedRealpath();
  for (const fileName of parsed.fileNames) {
    if (!isProductionSource(fileName, packageRoot)) continue;
    const realFile = resolveReal(fileName);
    const realRelative = path.relative(realPackageRoot, realFile);
    if (realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error(
        `${normalizePath(path.relative(packageRoot, fileName))}: source symlink resolves outside the package`,
      );
    }
  }

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  const checker = program.getTypeChecker();
  const findings = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (!isProductionSource(sourceFile.fileName, packageRoot)) continue;
    const visit = (node) => {
      if (ts.isExpressionStatement(node) && expressionCanFloatPromise(node.expression, checker)) {
        const start = node.expression.getStart(sourceFile);
        const location = sourceFile.getLineAndCharacterOfPosition(start);
        findings.push({
          file: normalizePath(path.relative(packageRoot, sourceFile.fileName)),
          line: location.line + 1,
          column: location.character + 1,
          expression: node.expression.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 160),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return findings.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column,
  );
}
