const { JSDOM } = require("jsdom");

function canonicalKey(input) {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("canonicalKey requires an http or https URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("canonicalKey rejects userinfo");
  }

  let path = url.pathname;
  while (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  const entries = [...new URLSearchParams(url.search).entries()];
  entries.sort((left, right) => {
    if (left[0] < right[0]) return -1;
    if (left[0] > right[0]) return 1;
    if (left[1] < right[1]) return -1;
    if (left[1] > right[1]) return 1;
    return 0;
  });
  const sorted = new URLSearchParams();
  for (const [name, value] of entries) {
    sorted.append(name, value);
  }
  const query = sorted.toString();

  const port = url.port === "" ? "" : `:${url.port}`;
  const key = `${url.protocol}//${url.hostname}${port}${path}`;
  return query === "" ? key : `${key}?${query}`;
}

function documentBase(document, pageUrl) {
  const base = document.querySelector("base");
  if (!base) {
    return new URL(pageUrl);
  }
  const raw = base.getAttribute("href");
  if (raw === null || raw.trim() === "") {
    return new URL(pageUrl);
  }
  try {
    return new URL(raw, pageUrl);
  } catch {
    return new URL(pageUrl);
  }
}

function extractLinks(html, pageUrl) {
  const document = new JSDOM(html).window.document;
  const base = documentBase(document, pageUrl);
  const links = [];

  for (const anchor of document.querySelectorAll("a")) {
    const raw = anchor.getAttribute("href");
    if (raw === null || raw.trim() === "") {
      continue;
    }
    let resolved;
    try {
      resolved = new URL(raw, base);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      continue;
    }
    if (resolved.username !== "" || resolved.password !== "") {
      continue;
    }
    resolved.hash = "";
    links.push(resolved.href);
  }

  return links;
}

module.exports = {
  canonicalKey,
  extractLinks,
};
