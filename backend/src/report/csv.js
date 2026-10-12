const COLUMNS = [
  "canonicalUrl",
  "requestedUrl",
  "finalUrl",
  "discoveredFrom",
  "depth",
  "state",
  "skipReason",
  "waitedMs",
  "statusCode",
  "contentType",
  "durationMs",
  "byteLength",
  "attempts",
  "errorKind",
  "errorMessage",
];

function csvCell(value) {
  if (value == null) {
    return "";
  }
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function formatCsv(result) {
  const lines = [COLUMNS.join(",")];
  for (const page of result.pages) {
    lines.push(COLUMNS.map((column) => csvCell(page[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

module.exports = {
  COLUMNS,
  formatCsv,
};
