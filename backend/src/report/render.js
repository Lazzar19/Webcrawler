const { ConfigError } = require("../crawler/crawl-config.js");
const { formatConsole, formatDetails } = require("./console.js");
const { formatCsv } = require("./csv.js");
const { formatJson } = require("./json.js");

const FORMATS = new Set(["console", "json", "csv"]);

function normalizeFormat(format) {
  if (format === undefined) {
    return "console";
  }
  if (!FORMATS.has(format)) {
    throw new ConfigError(`Unknown format: ${format}`);
  }
  return format;
}

function machineText(result, format) {
  if (format === "csv") {
    return formatCsv(result);
  }
  return formatJson(result);
}

function withTrace(text, trace) {
  if (!trace) {
    return text;
  }
  return `${text}${trace}`;
}

function renderReport(result, { format, output, details = false, trace = "" } = {}) {
  const chosen = normalizeFormat(format);
  const summary = formatConsole(result);
  const human = details && chosen === "console" ? formatDetails(result) : summary;
  const machine = chosen === "console" ? human : machineText(result, chosen);
  const file = output ? { path: output, text: machine } : null;
  const humanOnStdout = Boolean(output) || chosen === "console";
  return {
    stdout: humanOnStdout ? human : machine,
    stderr: withTrace(humanOnStdout ? "" : summary, trace),
    file,
  };
}

module.exports = {
  normalizeFormat,
  renderReport,
};
