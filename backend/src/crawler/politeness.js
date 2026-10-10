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

function createPolitenessGate({ clock, perOriginLimit, minIntervalMs, robots, fatalSignal }) {
  const origins = new Map();

  function originState(origin) {
    let state = origins.get(origin);
    if (!state) {
      state = {
        held: 0,
        waiters: [],
        nextAllowedAt: 0,
        lastStart: null,
      };
      origins.set(origin, state);
    }
    return state;
  }

  function createLease(origin, state) {
    let released = false;
    return {
      async beforeAttempt() {
        const gap = robots.gapMs(origin, minIntervalMs);
        const now = clock.now();
        let startAt = Math.max(now, state.nextAllowedAt);
        if (state.lastStart !== null) {
          startAt = Math.max(startAt, state.lastStart + gap);
        }
        state.lastStart = startAt;
        state.nextAllowedAt = startAt + gap;
        await sleepOrAbort(startAt - now, clock, fatalSignal);
      },
      release() {
        if (released) {
          return;
        }
        released = true;
        const resolve = state.waiters.shift();
        if (resolve) {
          resolve(createLease(origin, state));
          return;
        }
        state.held -= 1;
      },
    };
  }

  return {
    acquire(origin) {
      const state = originState(origin);
      if (state.held < perOriginLimit) {
        state.held += 1;
        return Promise.resolve(createLease(origin, state));
      }
      return new Promise((resolve) => {
        state.waiters.push(resolve);
      });
    },
  };
}

module.exports = {
  createPolitenessGate,
};
