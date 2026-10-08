const { createClock } = require("../src/crawler/clock");

test("the real clock reports the current time and sleeps", async () => {
  const clock = createClock();
  const before = Date.now();
  const now = clock.now();
  expect(now).toBeGreaterThanOrEqual(before);
  expect(now).toBeLessThanOrEqual(Date.now());

  let settled = false;
  const pending = clock.sleep(0).then(() => {
    settled = true;
  });
  expect(settled).toBe(false);
  await pending;
  expect(settled).toBe(true);
});
