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

function artifact(result, format) {
  if (format === "json") {
    return formatJson(result);
  }
  if (format === "csv") {
    return formatCsv(result);
  }
  return formatConsole(result);
}

function humanText(result, details) {
  return details ? formatDetails(result) : formatConsole(result);
}

function renderReport(result, { format, output, details = false } = {}) {
  const chosen = normalizeFormat(format);
  const summary = formatConsole(result);
  const human = humanText(result, details && chosen === "console");
  const body = chosen === "console" ? human : artifact(result, chosen);
  if (output) {
    return {
      stdout: chosen === "console" ? human : summary,
      stderr: "",
      file: { path: output, text: body },
    };
  }
  if (chosen === "console") {
    return { stdout: human, stderr: "", file: null };
  }
  return { stdout: body, stderr: summary, file: null };
}

module.exports = {
  normalizeFormat,
  renderReport,
};
