function formatJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

module.exports = {
  formatJson,
};
