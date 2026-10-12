const { ConfigError } = require("../crawler/crawl-config.js");
const { formatConsole } = require("./console.js");
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

function artifact(result, format) {
  if (format === "json") {
    return formatJson(result);
  }
  if (format === "csv") {
    return formatCsv(result);
  }
  return formatConsole(result);
}

function renderReport(result, { format, output } = {}) {
  const chosen = normalizeFormat(format);
  const summary = formatConsole(result);
  const body = artifact(result, chosen);
  if (output) {
    return {
      stdout: summary,
      stderr: "",
      file: { path: output, text: body },
    };
  }
  if (chosen === "console") {
    return { stdout: summary, stderr: "", file: null };
  }
  return { stdout: body, stderr: summary, file: null };
}

module.exports = {
  normalizeFormat,
  renderReport,
};
