export function parseHarnessArgs(argv) {
  const passthroughIndex = argv.indexOf("--");
  const harnessArgs = passthroughIndex >= 0 ? argv.slice(0, passthroughIndex) : argv;
  const pytestArgs = passthroughIndex >= 0 ? argv.slice(passthroughIndex + 1) : [];
  const levelIndex = harnessArgs.indexOf("--level");
  const transportIndex = harnessArgs.indexOf("--transport");
  return {
    selfCheck: harnessArgs.includes("--self-check"),
    verbose: harnessArgs.includes("--verbose"),
    level: levelIndex >= 0 ? harnessArgs[levelIndex + 1] : "must",
    transport: transportIndex >= 0 ? harnessArgs[transportIndex + 1] : "jsonrpc",
    pytestArgs,
  };
}

export function buildRunTckArgs({ runTckPath, baseUrl, level, transport, verbose = false, pytestArgs = [] }) {
  const args = [runTckPath, "--sut-host", baseUrl, "--transport", transport, "--level", level];
  if (verbose) args.push("--verbose");
  if (pytestArgs.length > 0) args.push("--", ...pytestArgs);
  return args;
}
