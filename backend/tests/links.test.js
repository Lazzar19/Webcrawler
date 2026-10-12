const { extractLinks, readHtml } = require("../src/crawler/url-policy");

const pageUrl = "https://example.com/dir/page";

function page(body) {
  return `<html><body>${body}</body></html>`;
}

test("resolves dot, dotdot, and bare paths against a base that has a path", () => {
  const html = page(`
    <a href="./a"></a>
    <a href="../a"></a>
    <a href="a"></a>
  `);
  expect(extractLinks(html, pageUrl)).toEqual([
    "https://example.com/dir/a",
    "https://example.com/a",
    "https://example.com/dir/a",
  ]);
});

test("resolves a query-only link against the current path", () => {
  expect(extractLinks(page('<a href="?x=1"></a>'), pageUrl)).toEqual([
    "https://example.com/dir/page?x=1",
  ]);
});

test("resolves a protocol-relative link with the base scheme", () => {
  expect(extractLinks(page('<a href="//cdn.example/a"></a>'), pageUrl)).toEqual([
    "https://cdn.example/a",
  ]);
});

test("uses the first base href when it parses", () => {
  const html = page(`
    <base href="/docs/">
    <a href="a"></a>
  `);
  expect(extractLinks(html, pageUrl)).toEqual(["https://example.com/docs/a"]);
});

test("keeps the page URL when the first base href does not parse", () => {
  const html = page(`
    <base href="http://[">
    <base href="/docs/">
    <a href="a"></a>
  `);
  expect(extractLinks(html, pageUrl)).toEqual(["https://example.com/dir/a"]);
});

test("ignores non-http schemes, userinfo, and blank hrefs", () => {
  const lines = [];
  const html = page(`
    <a href="mailto:x@example.com"></a>
    <a href="javascript:alert(1)"></a>
    <a href="https://user:pw@example.com/secret"></a>
    <a href="http://["></a>
    <a href="mailto:a@b.example\r\nX-Injected: 1"></a>
    <a href=""></a>
    <a href="   "></a>
    <a href="/kept"></a>
  `);
  expect(extractLinks(html, pageUrl, {
    debug(line) {
      lines.push(line);
    },
  })).toEqual(["https://example.com/kept"]);
  expect(lines).toEqual([
    `ignored scheme mailto:x@example.com base ${pageUrl}`,
    "ignored scheme javascript:alert(1) base https://example.com/dir/page",
    `ignored userinfo https://user:pw@example.com/secret base ${pageUrl}`,
    `ignored unparsable http://[ base ${pageUrl}`,
    `ignored scheme mailto:a@b.example X-Injected: 1 base ${pageUrl}`,
  ]);
});

test("resolved spellings keep a trailing slash and drop the fragment", () => {
  const html = page(`
    <a href="/a/"></a>
    <a href="/a/#section"></a>
  `);
  expect(extractLinks(html, "https://example.com/")).toEqual([
    "https://example.com/a/",
    "https://example.com/a/",
  ]);
});

test("the first canonical link keeps its raw href", () => {
  const html = page(`
    <link rel="stylesheet" href="/style.css">
    <link rel="author Canonical" href="/first#section">
    <link rel="canonical" href="/second">
    <a href="/kept"></a>
  `);
  const parsed = readHtml(html, pageUrl);

  expect(parsed.canonicalHref).toBe("/first#section");
  expect(parsed.links).toEqual(["https://example.com/kept"]);
});

test("a missing canonical tag and a non-token rel yield no href", () => {
  expect(readHtml(page('<a href="/a"></a>'), pageUrl).canonicalHref).toBeNull();
  expect(readHtml(page('<link rel="canonical-not" href="/nope">'), pageUrl).canonicalHref).toBeNull();
  expect(readHtml(page('<a rel="canonical" href="/no"></a>'), pageUrl).canonicalHref).toBeNull();
});

test("the first canonical link wins even when it has no href", () => {
  const html = page(`
    <link rel="canonical">
    <link rel="canonical" href="/second">
  `);

  expect(readHtml(html, pageUrl).canonicalHref).toBeNull();
});
