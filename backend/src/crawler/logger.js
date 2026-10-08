function formatArg(arg) {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg instanceof Error) {
    return arg.stack || arg.message;
  }
  return JSON.stringify(arg);
}

function createLogger(output = process.stderr) {
  function write(level, args) {
    output.write(`[${level}] ${args.map(formatArg).join(" ")}\n`);
  }

  return {
    debug(...args) {
      write("debug", args);
    },
    info(...args) {
      write("info", args);
    },
    warn(...args) {
      write("warn", args);
    },
    error(...args) {
      write("error", args);
    },
  };
}

module.exports = {
  createLogger,
};
