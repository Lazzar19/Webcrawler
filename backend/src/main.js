const { crawl } = require("./crawler/crawl.js");
const { ConfigError, createCrawlConfig } = require("./crawler/crawl-config.js");

function optionalInteger(raw) {
  if (raw === undefined) {
    return undefined;
  }
  return Number(raw);
}

async function main() {
  if (process.argv.length < 3) {
    console.log("no website provided");
    process.exit(1);
  }

  if (process.argv.length > 5) {
    console.log("to many command line arguments");
    process.exit(1);
  }

  const startUrl = process.argv[2];
  const maxDepth = optionalInteger(process.argv[3]);
  const maxPages = optionalInteger(process.argv[4]);
  const options = { startUrl };
  if (maxDepth !== undefined) {
    options.maxDepth = maxDepth;
  }
  if (maxPages !== undefined) {
    options.maxPages = maxPages;
  }

  let config;
  try {
    config = createCrawlConfig(options);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }

  const result = await crawl(config);
  console.log(
    `Crawled ${result.counts.fetched} pages, ${result.counts.failed} failed, ${result.counts.skipped} skipped`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
