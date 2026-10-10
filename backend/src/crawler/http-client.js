const ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";

class FetchError extends Error {
  constructor(kind, message, attempts) {
    super(message);
    this.name = "FetchError";
    this.kind = kind;
    this.attempts = attempts;
  }
}

function kindFromCause(error) {
  if (error?.name === "TimeoutError") {
    return "timeout";
  }
  const code = error?.cause?.code || error?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "dns";
  }
  if (code === "ECONNREFUSED" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return "connect";
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE") {
    return "reset";
  }
  if (
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    (typeof code === "string" && (code.startsWith("CERT_") || code.startsWith("ERR_TLS_")))
  ) {
    return "tls";
  }
  return "connect";
}

function errorMessage(error) {
  const code = error?.cause?.code || error?.code;
  return code ? `${error.message} (${code})` : error.message;
}

async function cancelBody(response) {
  if (response.body) {
    await response.body.cancel();
  }
}

async function readDecoded(response, maxBytes, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let body = "";
  let byteLength = 0;

  const failOversized = async () => {
    await reader.cancel();
    throw new FetchError("too-large", `response exceeds ${maxBytes} bytes`, 1);
  };

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        throw signal.reason;
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const text = decoder.decode(value, { stream: true });
      byteLength += Buffer.byteLength(text);
      if (byteLength > maxBytes) {
        await failOversized();
      }
      body += text;
    }
    const tail = decoder.decode();
    byteLength += Buffer.byteLength(tail);
    if (byteLength > maxBytes) {
      throw new FetchError("too-large", `response exceeds ${maxBytes} bytes`, 1);
    }
    body += tail;
    return { body, byteLength };
  } catch (error) {
    if (!(error instanceof FetchError)) {
      await reader.cancel().catch(() => {});
    }
    throw error;
  }
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_KINDS = new Set(["timeout", "connect", "reset"]);

function backoffMs(retryNumber, retryBaseDelayMs) {
  return Math.min(5000, retryBaseDelayMs * 2 ** (retryNumber - 1));
}

function retryAfterMs(header, now) {
  if (header == null) {
    return null;
  }
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.max(0, parsed - now);
}

function waitBeforeRetry(statusCode, retryAfter, completedAttempts, retryBaseDelayMs, now) {
  const backoff = backoffMs(completedAttempts, retryBaseDelayMs);
  let wait = backoff;
  if (statusCode === 429 || statusCode === 503) {
    const raised = retryAfterMs(retryAfter, now);
    if (raised !== null) {
      wait = Math.max(backoff, raised);
    }
  }
  return wait > 5000 ? null : wait;
}

function sleepOrAbort(ms, clock, fatalSignal) {
  if (ms <= 0 || fatalSignal?.aborted) {
    return Promise.resolve();
  }
  const sleeping = clock.sleep(ms);
  if (!fatalSignal) {
    return sleeping;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve();
    fatalSignal.addEventListener("abort", onAbort, { once: true });
    sleeping.then(resolve, reject).finally(() => {
      fatalSignal.removeEventListener("abort", onAbort);
    });
  });
}

function createHttpClient({
  fetchImpl,
  clock,
  userAgent,
  timeoutMs,
  retryCount = 0,
  retryBaseDelayMs = 500,
  fatalSignal,
} = {}) {
  const fetchFn = fetchImpl ?? fetch;
  const now = () => (clock ? clock.now() : Date.now());

  return {
    async get(url, { maxBytes, beforeAttempt, wantBody }) {
      const maxAttempts = retryCount + 1;
      let attempts = 0;
      let started = null;
      let pendingStatus = null;
      let pendingRetryAfter = null;
      let pendingResult = null;

      while (attempts < maxAttempts) {
        if (attempts > 0) {
          const wait = waitBeforeRetry(
            pendingStatus,
            pendingRetryAfter,
            attempts,
            retryBaseDelayMs,
            now(),
          );
          if (wait === null) {
            return pendingResult;
          }
          await sleepOrAbort(wait, clock, fatalSignal);
        }

        await beforeAttempt();
        if (started === null) {
          started = now();
        }
        attempts += 1;
        const signal = AbortSignal.timeout(timeoutMs);
        try {
          const response = await fetchFn(url, {
            redirect: "manual",
            signal,
            headers: {
              "user-agent": userAgent,
              accept: ACCEPT,
            },
          });
          const statusCode = response.status;
          const contentType = response.headers.get("content-type");
          const location = response.headers.get("location");
          const retryAfter = response.headers.get("retry-after");
          const readBody = statusCode >= 200 && statusCode < 300 && wantBody({ statusCode, contentType });
          let body = null;
          let byteLength = null;
          if (!readBody) {
            await cancelBody(response);
          } else {
            const declared = Number(response.headers.get("content-length"));
            if (Number.isFinite(declared) && declared > maxBytes) {
              await cancelBody(response);
              throw new FetchError("too-large", `response exceeds ${maxBytes} bytes`, attempts);
            }
            if (response.body) {
              const read = await readDecoded(response, maxBytes, signal);
              body = read.body;
              byteLength = read.byteLength;
            } else {
              body = "";
              byteLength = 0;
            }
          }

          const result = {
            url,
            statusCode,
            contentType,
            location,
            body,
            byteLength,
            attempts,
            durationMs: now() - started,
          };
          if (!RETRY_STATUSES.has(statusCode) || attempts >= maxAttempts) {
            return result;
          }
          pendingStatus = statusCode;
          pendingRetryAfter = retryAfter;
          pendingResult = result;
        } catch (error) {
          const cause = signal.aborted && signal.reason instanceof Error ? signal.reason : error;
          const failure = error instanceof FetchError
            ? error
            : new FetchError(kindFromCause(cause), errorMessage(cause), attempts);
          failure.attempts = attempts;
          if (!RETRYABLE_KINDS.has(failure.kind) || attempts >= maxAttempts) {
            throw failure;
          }
          pendingStatus = null;
          pendingRetryAfter = null;
          pendingResult = null;
        }
      }
    },
  };
}

module.exports = {
  FetchError,
  createHttpClient,
};
