const { writeFileSync } = require("node:fs");
const { ConfigError } = require("../crawler/crawl-config.js");
const { crawl } = require("../crawler/crawl.js");
const { renderReport, normalizeFormat } = require("../report/render.js");
const { createCliConfig } = require("./cli-config.js");
const { formatHelp } = require("./help.js");
const { formatTrace } = require("../crawler/trace.js");

const EXIT_OK = 0;
const EXIT_FATAL = 1;
const EXIT_CONFIG = 2;
const EXIT_SECOND_INTERRUPT = 130;

function writeLine(stream, message) {
  stream.write(`${message}\n`);
}

async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const writeFile = dependencies.writeFile ?? writeFileSync;
  const crawlImpl = dependencies.crawl ?? crawl;
  const exitNow = dependencies.exitNow ?? ((code) => process.exit(code));
  const signals = dependencies.signals ?? process;

  let invocation;
  let format;
  try {
    invocation = createCliConfig(argv);
    if (invocation.help) {
      stdout.write(formatHelp());
      return EXIT_OK;
    }
    format = normalizeFormat(invocation.format);
    if (invocation.details && format !== "console") {
      throw new ConfigError("--details is only valid with console output");
    }
  } catch (error) {
    writeLine(stderr, error.message);
    return error instanceof ConfigError ? EXIT_CONFIG : EXIT_FATAL;
  }

  const stop = new AbortController();
  const traceLines = [];
  let interrupts = 0;
  let secondInterrupt = false;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts === 1) {
      stop.abort();
      return;
    }
    secondInterrupt = true;
    exitNow(EXIT_SECOND_INTERRUPT);
  };
  signals.on("SIGINT", onSigint);

  try {
    const result = await crawlImpl(invocation.config, {
      signal: stop.signal,
      trace: invocation.trace
        ? (event, fields) => {
          traceLines.push(formatTrace(event, fields));
        }
        : undefined,
    });
    if (secondInterrupt) {
      return EXIT_SECOND_INTERRUPT;
    }
    const rendered = renderReport(result, {
      format,
      output: invocation.output,
      details: invocation.details,
      trace: traceLines.join(""),
    });
    if (rendered.file) {
      writeFile(rendered.file.path, rendered.file.text);
    }
    if (rendered.stderr) {
      stderr.write(rendered.stderr);
    }
    stdout.write(rendered.stdout);
    return EXIT_OK;
  } catch (error) {
    if (traceLines.length > 0) {
      stderr.write(traceLines.join(""));
    }
    writeLine(stderr, error.message);
    return EXIT_FATAL;
  } finally {
    signals.off("SIGINT", onSigint);
  }
}

module.exports = {
  EXIT_OK,
  EXIT_FATAL,
  EXIT_CONFIG,
  EXIT_SECOND_INTERRUPT,
  runCli,
};
