import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir:"./tests",timeout:30000,retries:0,workers:1,
  use:{baseURL:"http://127.0.0.1:3000",trace:"retain-on-failure",screenshot:"only-on-failure",...devices["Desktop Chrome"]},
  // The cloud-draft UI is feature-flagged; CI and the production deploy build with the flag ON, so tests do too.
  webServer:{command:"npm run dev -- --host 127.0.0.1",url:"http://127.0.0.1:3000/milanochat/",reuseExistingServer:false,timeout:60000,env:{VITE_ENABLE_CLOUD_FLOW_DRAFTS:"true"}},
});
