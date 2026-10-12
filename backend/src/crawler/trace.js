const FIELD_ORDER = {
  "crawl-start": ["url"],
  reserved: ["url", "depth", "reason"],
  skipped: ["url", "reason"],
  take: ["url", "depth", "sequence"],
  "robots-check": ["url", "allowed", "reason"],
  "attempt-start": ["url", "attempt"],
  retry: ["url", "next", "wait", "status", "kind"],
  redirect: ["from", "to", "status"],
  links: ["url", "discovered"],
  commit: ["sequence", "state"],
  fatal: ["message"],
  "crawl-stop": ["reason"],
};

const RAW_VALUE = /^[A-Za-z0-9._:/-]+$/;

function redactUserinfo(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  if (url.username === "" && url.password === "") {
    return text;
  }
  url.username = "***";
  url.password = "";
  return url.href;
}

function formatValue(value) {
  const text = redactUserinfo(String(value)).replace(/[\r\n]+/g, " ");
  if (RAW_VALUE.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function formatTrace(event, fields) {
  const keys = FIELD_ORDER[event] ?? [];
  const parts = [`[trace] ${event}`];
  for (const key of keys) {
    if (fields[key] == null) {
      continue;
    }
    parts.push(`${key}=${formatValue(fields[key])}`);
  }
  return `${parts.join(" ")}\n`;
}

function emitTrace(trace, event, fields) {
  if (!trace) {
    return;
  }
  trace(event, fields);
}

module.exports = {
  formatTrace,
  emitTrace,
};
