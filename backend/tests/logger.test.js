const { createLogger } = require("../src/crawler/logger");

test("the default logger writes every level to stderr", () => {
  const lines = [];
  const write = jest.spyOn(process.stderr, "write").mockImplementation((line) => {
    lines.push(line);
    return true;
  });

  const logger = createLogger();
  logger.debug("debug-line");
  logger.info("info-line", { n: 1 });
  logger.warn("warn-line");
  logger.error("error-line", new Error("boom"));

  write.mockRestore();

  expect(lines[0]).toBe("[debug] debug-line\n");
  expect(lines[1]).toBe('[info] info-line {"n":1}\n');
  expect(lines[2]).toBe("[warn] warn-line\n");
  expect(lines[3]).toContain("[error] error-line Error: boom");
});

test("a logger can write to an injected stream", () => {
  const lines = [];
  const logger = createLogger({
    write(line) {
      lines.push(line);
      return true;
    },
  });

  logger.info("kept off stderr");
  expect(lines).toEqual(["[info] kept off stderr\n"]);
});
