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

function advancingClock(start = 0) {
  let time = start;
  const sleeps = [];
  return {
    now: () => time,
    sleep(ms) {
      sleeps.push(ms);
      time += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

function retryClient(fetchImpl, { retryCount = 2, retryBaseDelayMs = 500, clock: clockImpl = advancingClock(), fatalSignal } = {}) {
  return {
    http: createHttpClient({
      fetchImpl,
      clock: clockImpl,
      userAgent: "WebcrawlerBot/1.0",
      timeoutMs: 1000,
      retryCount,
      retryBaseDelayMs,
      fatalSignal,
    }),
    clock: clockImpl,
  };
}

function statusResponse(status, headers = {}) {
  return responseFrom({ status, headers, body: null });
}

test("backoff runs before beforeAttempt, then the next attempt", async () => {
  const events = [];
  let calls = 0;
  const clockImpl = advancingClock(1000);
  const { http } = retryClient((url, options) => {
    calls += 1;
    events.push(`fetch:${clockImpl.now()}:${options.signal.aborted}`);
    if (calls === 1) {
      throw fetchFailed("ECONNRESET");
    }
    return statusResponse(200, { "content-type": "text/html" });
  }, { retryCount: 1, clock: clockImpl });
  const realSleep = clockImpl.sleep.bind(clockImpl);
  clockImpl.sleep = async (ms) => {
    events.push(`sleep:${ms}`);
    await realSleep(ms);
  };

  const response = await http.get("https://example.com/", {
    maxBytes: 100,
    async beforeAttempt() {
      events.push(`before:${clockImpl.now()}`);
    },
    wantBody: () => false,
  });

  expect(events).toEqual([
    "before:1000",
    "fetch:1000:false",
    "sleep:500",
    "before:1500",
    "fetch:1500:false",
  ]);
  expect(response.attempts).toBe(2);
  expect(response.durationMs).toBe(500);
});

test("retry delays double and stop at 5000", async () => {
  let calls = 0;
  const { http, clock: clockImpl } = retryClient(() => {
    calls += 1;
    throw fetchFailed("ECONNREFUSED");
  }, { retryCount: 2, retryBaseDelayMs: 3000 });

  const pending = http.get("https://example.com/", htmlOptions(100));
  await expect(pending).rejects.toMatchObject({ kind: "connect", attempts: 3 });
  expect(calls).toBe(3);
  expect(clockImpl.sleeps).toEqual([3000, 5000]);
});

test.each([
  [429, "6", []],
  [503, "6", []],
])("status %s with Retry-After above 5000 ms is returned", async (status, retryAfter, sleeps) => {
  let calls = 0;
  const { http, clock: clockImpl } = retryClient(() => {
    calls += 1;
    return statusResponse(status, { "retry-after": retryAfter });
  });

  const response = await http.get("https://example.com/", {
    maxBytes: 100,
    async beforeAttempt() {},
    wantBody: () => false,
  });
  expect(response.statusCode).toBe(status);
  expect(response.attempts).toBe(1);
  expect(calls).toBe(1);
  expect(clockImpl.sleeps).toEqual(sleeps);
});

test("Retry-After seconds raise the wait and never lower it", async () => {
  const seen = [];
  const { http, clock: clockImpl } = retryClient(() => {
    seen.push("fetch");
    if (seen.length === 1) {
      return statusResponse(429, { "retry-after": "3" });
    }
    if (seen.length === 2) {
      return statusResponse(503, { "retry-after": "0" });
    }
    return statusResponse(200);
  }, { retryCount: 2 });

  const response = await http.get("https://example.com/", {
    maxBytes: 100,
    async beforeAttempt() {},
    wantBody: () => false,
  });
  expect(response.statusCode).toBe(200);
  expect(response.attempts).toBe(3);
  expect(clockImpl.sleeps).toEqual([3000, 1000]);
});

test("a Retry-After date in the future raises the wait, and a past or invalid value does not", async () => {
  const now = 1_700_000_000_000;
  const future = new Date(now + 3000).toUTCString();
  const past = new Date(now - 1000).toUTCString();
  const headers = [future, past, "not-a-date"];
  let calls = 0;
  const { http, clock: clockImpl } = retryClient(() => {
    const header = headers[calls];
    calls += 1;
    if (calls < 4) {
      return statusResponse(503, { "retry-after": header });
    }
    return statusResponse(200);
  }, { retryCount: 3, clock: advancingClock(now) });

  const response = await http.get("https://example.com/", {
    maxBytes: 100,
    async beforeAttempt() {},
    wantBody: () => false,
  });
  expect(response.attempts).toBe(4);
  expect(clockImpl.sleeps).toEqual([3000, 1000, 2000]);
});

test("Retry-After on a status other than 429 or 503 is ignored", async () => {
  let calls = 0;
  const { http, clock: clockImpl } = retryClient(() => {
    calls += 1;
    if (calls === 1) {
      return statusResponse(500, { "retry-after": "9" });
    }
    return statusResponse(200);
  }, { retryCount: 1 });

  const response = await http.get("https://example.com/", {
    maxBytes: 100,
    async beforeAttempt() {},
    wantBody: () => false,
  });
  expect(response.attempts).toBe(2);
  expect(clockImpl.sleeps).toEqual([500]);
});

test.each([
  ["dns", "ENOTFOUND"],
  ["tls", "CERT_HAS_EXPIRED"],
])("%s is not retried", async (kind, code) => {
  let calls = 0;
  const { http, clock: clockImpl } = retryClient(() => {
    calls += 1;
    throw fetchFailed(code);
  });

  const pending = http.get("https://example.com/", htmlOptions(100));
  await expect(pending).rejects.toMatchObject({ kind, attempts: 1 });
  expect(calls).toBe(1);
  expect(clockImpl.sleeps).toEqual([]);
});

test.each([302, 404, 400])("status %s is not retried", async (status) => {
  let calls = 0;
  const { http, clock: clockImpl } = retryClient(() => {
    calls += 1;
    return statusResponse(status, { location: "https://example.com/next" });
  });

  const response = await http.get("https://example.com/", {
    maxBytes: 100,
    async beforeAttempt() {},
    wantBody: () => false,
  });
  expect(response.statusCode).toBe(status);
  expect(response.attempts).toBe(1);
  expect(calls).toBe(1);
  expect(clockImpl.sleeps).toEqual([]);
});

test("an exhausted retryable status is returned, not thrown", async () => {
  let calls = 0;
  const { http } = retryClient(() => {
    calls += 1;
    return statusResponse(503);
  }, { retryCount: 2 });

  const response = await http.get("https://example.com/", {
    maxBytes: 100,
    async beforeAttempt() {},
    wantBody: () => false,
  });
  expect(response.statusCode).toBe(503);
  expect(response.attempts).toBe(3);
  expect(calls).toBe(3);
});

test("too-large is not retried", async () => {
  let calls = 0;
  const { http, clock: clockImpl } = retryClient(() => {
    calls += 1;
    return responseFrom({
      status: 200,
      headers: { "content-type": "text/html", "content-length": "1000" },
      body: {
        getReader() {
          throw new Error("body was read");
        },
        cancel() {
          return Promise.resolve();
        },
      },
    });
  });

  const pending = http.get("https://example.com/", htmlOptions(10));
  await expect(pending).rejects.toMatchObject({ kind: "too-large", attempts: 1 });
  expect(calls).toBe(1);
  expect(clockImpl.sleeps).toEqual([]);
});

test("fatal-stop ends the retry sleep and does not abort the fetch", async () => {
  const fatal = new AbortController();
  let calls = 0;
  let releaseSleep;
  let fetchSignal;
  const http = createHttpClient({
    fetchImpl: (_url, options) => {
      calls += 1;
      fetchSignal = options.signal;
      if (calls === 1) {
        throw fetchFailed("ECONNRESET");
      }
      return statusResponse(200);
    },
    clock: {
      now: () => 0,
      sleep() {
        return new Promise((resolve) => {
          releaseSleep = resolve;
        });
      },
    },
    userAgent: "WebcrawlerBot/1.0",
    timeoutMs: 1000,
    retryCount: 1,
    retryBaseDelayMs: 500,
    fatalSignal: fatal.signal,
  });
  const hooks = [];
  const pending = http.get("https://example.com/", {
    maxBytes: 100,
    async beforeAttempt() {
      hooks.push("before");
    },
    wantBody: () => false,
  });

  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  expect(typeof releaseSleep).toBe("function");
  fatal.abort();
  const response = await pending;
  releaseSleep();

  expect(response.attempts).toBe(2);
  expect(hooks).toEqual(["before", "before"]);
  expect(fetchSignal.aborted).toBe(false);
  expect(fetchSignal).not.toBe(fatal.signal);
});
