// Playwright config for the algorithm test suite.
// The app is a static site served by Python's http.server; Playwright spins it
// up automatically (reuseExistingServer: true so a manually-started preview
// server is fine too).

module.exports = {
  testDir: './tests',
  timeout: 15_000,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3460',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'python -m http.server 3460',
    port: 3460,
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'pipe'
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } }
  ]
};
