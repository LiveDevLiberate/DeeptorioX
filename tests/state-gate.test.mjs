import test from "node:test";
import assert from "node:assert/strict";

import { isAgentMutationRequest, stateGateNudge } from "../dist/state-gate.js";

test("classifies only external agent mutations for the state gate", () => {
  assert.equal(isAgentMutationRequest("POST", "/api/agent/act/build"), true);
  assert.equal(isAgentMutationRequest("POST", "/api/agent/act/copy-settings"), true);
  assert.equal(isAgentMutationRequest("POST", "/api/agent/jobs"), true);
  assert.equal(isAgentMutationRequest("POST", "/api/agent/observe/world"), false);
  assert.equal(isAgentMutationRequest("POST", "/api/agent/state"), false);
  assert.equal(isAgentMutationRequest("GET", "/api/agent/tools"), false);
  assert.equal(isAgentMutationRequest("GET", "/api/agent/jobs/id"), false);
  assert.equal(isAgentMutationRequest("POST", "/api/agent/jobs/id/cancel"), false);
  assert.equal(isAgentMutationRequest("POST", "/api/runs"), false);
});

test("stateGateNudge describes the write-state first step", () => {
  const nudge = stateGateNudge({
    blocked: true,
    age_seconds: 700,
    hard_seconds: 600,
    hint: "STATE.md is 700s old",
  });
  assert.equal(nudge.reason, "plan_stale");
  assert.equal(nudge.first_step, "write_state");
  assert.equal(nudge.age_seconds, 700);
  assert.match(nudge.message, /700s/);
});
