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

function createHttpClient({ fetchImpl, clock, userAgent, timeoutMs } = {}) {
  const fetchFn = fetchImpl ?? fetch;
  const now = () => (clock ? clock.now() : Date.now());

  return {
    async get(url, { maxBytes, beforeAttempt, wantBody }) {
      await beforeAttempt();
      const started = now();
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
        const readBody = statusCode >= 200 && statusCode < 300 && wantBody({ statusCode, contentType });
        let body = null;
        let byteLength = null;
        if (!readBody) {
          await cancelBody(response);
        } else {
          const declared = Number(response.headers.get("content-length"));
          if (Number.isFinite(declared) && declared > maxBytes) {
            await cancelBody(response);
            throw new FetchError("too-large", `response exceeds ${maxBytes} bytes`, 1);
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

        return {
          url,
          statusCode,
          contentType,
          location,
          body,
          byteLength,
          attempts: 1,
          durationMs: now() - started,
        };
      } catch (error) {
        if (error instanceof FetchError) {
          throw error;
        }
        const cause = signal.aborted && signal.reason instanceof Error ? signal.reason : error;
        throw new FetchError(kindFromCause(cause), errorMessage(cause), 1);
      }
    },
  };
}

module.exports = {
  FetchError,
  createHttpClient,
};
