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

function createHttpClient({ fetchImpl, clock, userAgent } = {}) {
  const fetchFn = fetchImpl ?? fetch;
  const now = () => (clock ? clock.now() : Date.now());

  return {
    async get(url, { beforeAttempt, wantBody }) {
      await beforeAttempt();
      const started = now();
      let response;
      try {
        response = await fetchFn(url, {
          redirect: "manual",
          headers: {
            "user-agent": userAgent,
            accept: ACCEPT,
          },
        });
      } catch (error) {
        const kind = kindFromCause(error);
        const code = error?.cause?.code || error?.code;
        const message = code ? `${error.message} (${code})` : error.message;
        throw new FetchError(kind, message, 1);
      }

      const statusCode = response.status;
      const contentType = response.headers.get("content-type");
      const location = response.headers.get("location");
      const readBody = statusCode >= 200 && statusCode < 300 && wantBody({ statusCode, contentType });
      let body = null;
      let byteLength = null;
      if (readBody) {
        body = await response.text();
        byteLength = Buffer.byteLength(body);
      } else if (response.body) {
        await response.body.cancel();
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
    },
  };
}

module.exports = {
  FetchError,
  createHttpClient,
};
