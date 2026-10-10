const { createHttpClient } = require("../src/crawler/http-client");

const clock = { now: () => 1_700_000_000_000 };

function client(fetchImpl, timeoutMs = 1000) {
  return createHttpClient({
    fetchImpl,
    clock,
    userAgent: "WebcrawlerBot/1.0",
    timeoutMs,
  });
}

function htmlOptions(maxBytes) {
  return {
    maxBytes,
    async beforeAttempt() {},
    wantBody() {
      return true;
    },
  };
}

function fetchFailed(code) {
  const error = new TypeError("fetch failed");
  error.cause = { code };
  return error;
}

test.each([
  ["ENOTFOUND", "dns"],
  ["EAI_AGAIN", "dns"],
  ["ECONNREFUSED", "connect"],
  ["UND_ERR_CONNECT_TIMEOUT", "connect"],
  ["ECONNRESET", "reset"],
  ["UND_ERR_SOCKET", "reset"],
  ["EPIPE", "reset"],
  ["CERT_HAS_EXPIRED", "tls"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls"],
  ["EHOSTUNREACH", "connect"],
])("cause.code %s is %s", async (code, kind) => {
  const http = client(() => {
    throw fetchFailed(code);
  });

  const pending = http.get("https://example.com/", htmlOptions(1000));
  await expect(pending).rejects.toMatchObject({
    name: "FetchError",
    kind,
    attempts: 1,
    message: `fetch failed (${code})`,
  });
});

test("a code on the error itself is mapped the same way", async () => {
  const error = new TypeError("fetch failed");
  error.code = "ENOTFOUND";
  const http = client(() => {
    throw error;
  });

  const pending = http.get("https://example.com/", htmlOptions(1000));
  await expect(pending).rejects.toMatchObject({
    kind: "dns",
    message: "fetch failed (ENOTFOUND)",
  });
});

test("a timeout while waiting for headers is FetchError timeout", async () => {
  const http = client((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason);
    });
  }), 30);

  const pending = http.get("https://example.com/", htmlOptions(1000));
  await expect(pending).rejects.toMatchObject({ name: "FetchError", kind: "timeout", attempts: 1 });
});

function responseFrom({ status = 200, headers = {}, body }) {
  const headerMap = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    status,
    headers: {
      get(name) {
        return headerMap.get(name.toLowerCase()) ?? null;
      },
    },
    body,
  };
}

test("a Content-Length above the limit fails without reading the body", async () => {
  let pulled = false;
  const http = client(async () => responseFrom({
    headers: {
      "content-type": "text/html",
      "content-length": "1000",
    },
    body: {
      getReader() {
        pulled = true;
        throw new Error("body was read");
      },
      async cancel() {},
    },
  }));

  const pending = http.get("https://example.com/", htmlOptions(10));
  await expect(pending).rejects.toMatchObject({ kind: "too-large" });
  expect(pulled).toBe(false);
});

test("decoded bytes are counted as chunks arrive and a later chunk stops the read", async () => {
  const encoder = new TextEncoder();
  const chunks = [encoder.encode("abcd"), encoder.encode("ef"), encoder.encode("SHOULD NOT BE READ")];
  let index = 0;
  let cancelled = false;
  const http = client(async () => responseFrom({
    headers: { "content-type": "text/html" },
    body: {
      getReader() {
        return {
          async read() {
            if (cancelled || index >= chunks.length) {
              return { done: true, value: undefined };
            }
            const value = chunks[index];
            index += 1;
            return { done: false, value };
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
      async cancel() {
        cancelled = true;
      },
    },
  }));

  const pending = http.get("https://example.com/", htmlOptions(5));
  await expect(pending).rejects.toMatchObject({ kind: "too-large" });
  expect(index).toBe(2);
  expect(cancelled).toBe(true);
});

test("a body within the limit is returned with its decoded length", async () => {
  const http = client(async () => new Response("<html>ok</html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  }));

  const response = await http.get("https://example.com/", htmlOptions(1000));
  expect(response.body).toBe("<html>ok</html>");
  expect(response.byteLength).toBe(Buffer.byteLength("<html>ok</html>"));
  expect(response.attempts).toBe(1);
});

test("a non-html response cancels the body", async () => {
  let cancelled = false;
  const http = client(async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("plain"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  });

  const response = await http.get("https://example.com/", {
    maxBytes: 1000,
    async beforeAttempt() {},
    wantBody() {
      return false;
    },
  });
  expect(response.body).toBeNull();
  expect(response.byteLength).toBeNull();
  expect(cancelled).toBe(true);
});
