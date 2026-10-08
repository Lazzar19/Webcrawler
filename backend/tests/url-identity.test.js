const { test, expect } = require("@jest/globals");

// Milestone 1 checkpoint. This is the URL-identity spec from PLAN.md.
// canonicalKey is intentionally not the policy. It returns a sentinel so
// each assertion runs and fails. test.failing keeps `npm test` green until
// the author approves implementation. The first implementation step is to
// delete this function, implement the key, and replace test.failing with test.

function canonicalKey() {
  return "NOT-IMPLEMENTED";
}

const KEY_CASES = [
  {
    name: "drops the fragment",
    input: "https://example.com/a#section",
    expected: "https://example.com/a",
  },
  {
    name: "drops an empty fragment",
    input: "https://example.com/a#",
    expected: "https://example.com/a",
  },
  {
    name: "keeps the scheme",
    input: "http://example.com/a",
    expected: "http://example.com/a",
  },
  {
    name: "lowercases the scheme and hostname",
    input: "HTTP://EXAMPLE.COM/a",
    expected: "http://example.com/a",
  },
  {
    name: "keeps www",
    input: "https://www.example.com/a",
    expected: "https://www.example.com/a",
  },
  {
    name: "omits the default http port",
    input: "http://example.com:80/a",
    expected: "http://example.com/a",
  },
  {
    name: "omits the default https port",
    input: "https://example.com:443/a",
    expected: "https://example.com/a",
  },
  {
    name: "keeps a non-default port",
    input: "https://example.com:8443/a",
    expected: "https://example.com:8443/a",
  },
  {
    name: "treats a missing slash and a root slash as one key",
    input: "https://example.com",
    expected: "https://example.com/",
  },
  {
    name: "keeps the root slash",
    input: "https://example.com/",
    expected: "https://example.com/",
  },
  {
    name: "removes one trailing slash from a longer path",
    input: "https://example.com/a/",
    expected: "https://example.com/a",
  },
  {
    name: "removes one trailing slash from a nested path",
    input: "https://example.com/a/b/",
    expected: "https://example.com/a/b",
  },
  {
    name: "removes repeated trailing slashes until the key is stable",
    input: "https://example.com/a//",
    expected: "https://example.com/a",
  },
  {
    name: "keeps an internal empty path segment",
    input: "https://example.com/a//b",
    expected: "https://example.com/a//b",
  },
  {
    name: "removes only the trailing slash after an internal empty segment",
    input: "https://example.com/a//b/",
    expected: "https://example.com/a//b",
  },
  {
    name: "keeps port 443 on http",
    input: "http://example.com:443/a",
    expected: "http://example.com:443/a",
  },
  {
    name: "keeps port 80 on https",
    input: "https://example.com:80/a",
    expected: "https://example.com:80/a",
  },
  {
    name: "removes a trailing slash before a query",
    input: "https://example.com/a/?x=1",
    expected: "https://example.com/a?x=1",
  },
  {
    name: "removes a trailing slash and a fragment before the query",
    input: "https://example.com/a/?x=1#section",
    expected: "https://example.com/a?x=1",
  },
  {
    name: "keeps the root slash when a query is present",
    input: "https://example.com/?x=1",
    expected: "https://example.com/?x=1",
  },
  {
    name: "sorts query names by code unit, with uppercase before lowercase",
    input: "https://example.com/a?a=1&B=1",
    expected: "https://example.com/a?B=1&a=1",
  },
  {
    name: "treats a bare query name and an empty value as one key",
    input: "https://example.com/a?a",
    expected: "https://example.com/a?a=",
  },
  {
    name: "keeps a repeated query pair",
    input: "https://example.com/a?a=1&a=1",
    expected: "https://example.com/a?a=1&a=1",
  },
  {
    name: "does not lowercase a percent escape in the path",
    input: "https://example.com/a%7E",
    expected: "https://example.com/a%7E",
  },
  {
    name: "does not decode a percent-encoded slash into a path separator",
    input: "https://example.com/a%2Fb",
    expected: "https://example.com/a%2Fb",
  },
  {
    name: "keeps path case",
    input: "https://example.com/Path",
    expected: "https://example.com/Path",
  },
  {
    name: "treats a missing query and an empty query as one key",
    input: "https://example.com/a?",
    expected: "https://example.com/a",
  },
  {
    name: "sorts query parameters by name",
    input: "https://example.com/a?b=1&a=2",
    expected: "https://example.com/a?a=2&b=1",
  },
  {
    name: "sorts equal query names by value",
    input: "https://example.com/a?a=2&a=1",
    expected: "https://example.com/a?a=1&a=2",
  },
  {
    name: "serializes a space in a query value with URLSearchParams",
    input: "https://example.com/a?q=b a",
    expected: "https://example.com/a?q=b+a",
  },

  {
    name: "omits ? when the serialized query is empty",
    input: "https://example.com/a?&",
    expected: "https://example.com/a",
  },
];

for (const row of KEY_CASES) {
  test.failing(row.name, () => {
    const key = canonicalKey(row.input);
    expect(key).toBe(row.expected);
    expect(canonicalKey(key)).toBe(key);
  });
}


test.failing("percent-escapes in the query are normalized by URLSearchParams", () => {
  for (const input of [
    "https://example.com/a?q=%7e",
    "https://example.com/a?q=%7E",
    "https://example.com/a?q=~",
  ]) {
    expect(canonicalKey(input)).toBe("https://example.com/a?q=%7E");
  }
});

test.failing("non-http(s) schemes throw TypeError", () => {
  expect(() => canonicalKey("mailto:x@example.com")).toThrow(TypeError);
  expect(() => canonicalKey("ftp://example.com/a")).toThrow(TypeError);
});

test.failing("different query values stay different keys", () => {
  expect(canonicalKey("https://example.com/a?id=1")).toBe(
    "https://example.com/a?id=1"
  );
  expect(canonicalKey("https://example.com/a?id=2")).toBe(
    "https://example.com/a?id=2"
  );
  expect(canonicalKey("https://example.com/a?id=1")).not.toBe(
    canonicalKey("https://example.com/a?id=2")
  );
});

test.failing("a missing query and an empty query are one key", () => {
  expect(canonicalKey("https://example.com/a")).toBe("https://example.com/a");
  expect(canonicalKey("https://example.com/a?")).toBe("https://example.com/a");
});

test.failing("query name and empty value stay one key", () => {
  expect(canonicalKey("https://example.com/a?a")).toBe("https://example.com/a?a=");
  expect(canonicalKey("https://example.com/a?a=")).toBe("https://example.com/a?a=");
});

test.failing("plus and percent-encoded space are one query value", () => {
  expect(canonicalKey("https://example.com/a?q=b%20a")).toBe(
    "https://example.com/a?q=b+a"
  );
  expect(canonicalKey("https://example.com/a?q=b+a")).toBe(
    "https://example.com/a?q=b+a"
  );
});

test.failing("percent-encoded tildes of different case stay different keys", () => {
  expect(canonicalKey("https://example.com/%7e")).toBe("https://example.com/%7e");
  expect(canonicalKey("https://example.com/%7E")).toBe("https://example.com/%7E");
  expect(canonicalKey("https://example.com/%7e")).not.toBe(
    canonicalKey("https://example.com/%7E")
  );
});

test.failing("percent-encoded slashes of different case stay different keys", () => {
  expect(canonicalKey("https://example.com/a%2Fb")).not.toBe(
    canonicalKey("https://example.com/a%2fb")
  );
  expect(canonicalKey("https://example.com/a%2Fb")).not.toBe(
    canonicalKey("https://example.com/a/b")
  );
});

test.failing("invalid input throws TypeError and is not a sentinel key", () => {
  expect(() => canonicalKey("not a url")).toThrow(TypeError);
  expect(() => canonicalKey("/a")).toThrow(TypeError);
});

test.failing("userinfo is not stripped into a key without credentials", () => {
  expect(() => canonicalKey("https://user:pw@example.com/a")).toThrow(TypeError);
  expect(() => canonicalKey("https://user@example.com/a")).toThrow(TypeError);
});

test.failing("spellings that share a canonical key", () => {
  const aliases = [
    ["https://example.com/old/", "https://example.com/old", "https://example.com/old"],
    [
      "https://example.com/page?b=1&a=2",
      "https://example.com/page?a=2&b=1",
      "https://example.com/page?a=2&b=1",
    ],
    ["https://example.com/page#section", "https://example.com/page", "https://example.com/page"],
    ["https://example.com:443/page", "https://example.com/page", "https://example.com/page"],
    ["https://example.com", "https://example.com/", "https://example.com/"],
  ];

  for (const [left, right, expected] of aliases) {
    expect(canonicalKey(left)).toBe(expected);
    expect(canonicalKey(right)).toBe(expected);
    expect(canonicalKey(canonicalKey(left))).toBe(expected);
  }
});

test.failing("these pairs stay different keys", () => {
  const distinct = [
    ["http://example.com/a", "https://example.com/a"],
    ["https://www.example.com/a", "https://example.com/a"],
    ["https://example.com:8443/a", "https://example.com/a"],
    ["https://example.com/a?id=1", "https://example.com/a?id=2"],
    ["https://example.com/Path", "https://example.com/path"],
  ];

  for (const [left, right] of distinct) {
    expect(canonicalKey(left)).not.toBe(canonicalKey(right));
  }
});
