function createPolitenessGate() {
  return {
    async acquire() {
      return {
        async beforeAttempt() {},
        release() {},
      };
    },
  };
}

module.exports = {
  createPolitenessGate,
};
