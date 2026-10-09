function createRobotsCheck() {
  return {
    async check() {
      return { allowed: true };
    },
  };
}

module.exports = {
  createRobotsCheck,
};
