import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureGameWindow, captureScriptPath, visualObservation} from '../dist/vision.js';

// Minimal PNG header: signature + IHDR (the manager validates signature, IHDR
// type, and dimensions; it deliberately does not decode pixels or check CRCs).
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngHeader(width, height, {magic = true, ihdr = true} = {}) {
  const buffer = Buffer.alloc(33);
  if (magic) PNG_MAGIC.copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write(ihdr ? 'IHDR' : 'IDAT', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8; // bit depth
  buffer[25] = 6; // RGBA
  return buffer;
}

function capturePathFrom(args) {
  const index = args.indexOf('-Out');
  assert.notEqual(index, -1, 'capture must pass -Out to the script');
  return args[index + 1];
}

// Stand-in for the real PowerShell runner: writes exactly what capture-window.ps1
// would write, records the invocation, and never spawns a process.
function fakeRunner(writes) {
  const calls = [];
  const exec = async (bin, args, options) => {
    calls.push({bin, args, options});
    const target = capturePathFrom(args);
    if (writes !== undefined) fs.writeFileSync(target, writes);
    return {stdout: '{}', stderr: ''};
  };
  return {exec, calls};
}

const windowsDeps = exec => ({platform: 'win32', exec});

test('captures the game window as a base64 PNG and removes the temp directory', async () => {
  const {exec, calls} = fakeRunner(pngHeader(1920, 1080));
  const capture = await captureGameWindow({}, windowsDeps(exec));
  assert.equal(capture.format, 'png');
  assert.equal(capture.source, 'window');
  assert.equal(capture.width, 1920);
  assert.equal(capture.height, 1080);
  assert.deepEqual(Buffer.from(capture.base64, 'base64'), pngHeader(1920, 1080));

  assert.equal(calls.length, 1);
  const [{bin, args, options}] = calls;
  assert.match(bin, /powershell\.exe$/i);
  assert.ok(args.includes('-NoProfile'));
  assert.ok(args.includes('-NonInteractive'));
  const script = args[args.indexOf('-File') + 1];
  assert.equal(script, captureScriptPath());
  assert.match(script, /scripts[\\/]capture-window\.ps1$/);
  assert.ok(fs.existsSync(script), 'capture script must exist next to the compiled module');
  assert.equal(args[args.indexOf('-Title') + 1], 'Factorio');
  assert.ok(options.timeout > 0);
  assert.equal(fs.existsSync(path.dirname(capturePathFrom(args))), false, 'temporary capture directory must be removed');
});

test('forwards a custom window title and clamps the timeout', async () => {
  const titled = fakeRunner(pngHeader(640, 480));
  await captureGameWindow({title: ' Factorio 2.0 ', timeoutMs: 4500}, windowsDeps(titled.exec));
  assert.equal(titled.calls[0].args[titled.calls[0].args.indexOf('-Title') + 1], 'Factorio 2.0');
  assert.equal(titled.calls[0].options.timeout, 4500);

  const clamped = fakeRunner(pngHeader(640, 480));
  await captureGameWindow({timeoutMs: 5}, windowsDeps(clamped.exec));
  assert.equal(clamped.calls[0].options.timeout, 2000);
});

test('rejects non-Windows hosts without running a capture', async () => {
  let called = false;
  await assert.rejects(
    captureGameWindow({}, {platform: 'linux', exec: async () => { called = true; return {stdout: '', stderr: ''}; }}),
    /visual_capture_unsupported_platform/,
  );
  assert.equal(called, false);
  if (process.platform !== 'win32') {
    await assert.rejects(captureGameWindow(), /visual_capture_unsupported_platform/);
  }
});

test('surfaces PowerShell failures and still removes the temp directory', async () => {
  let capturePath;
  await assert.rejects(
    captureGameWindow({}, windowsDeps(async (bin, args) => {
      capturePath = capturePathFrom(args);
      throw new Error('powershell.exe exited with 2: game_window_not_found');
    })),
    /visual_capture_failed.*game_window_not_found/s,
  );
  assert.ok(capturePath);
  assert.equal(fs.existsSync(path.dirname(capturePath)), false);
});

test('a capture process that writes no PNG fails cleanly', async () => {
  const {exec} = fakeRunner(undefined);
  await assert.rejects(captureGameWindow({}, windowsDeps(exec)), /visual_capture_failed/);
});

test('rejects captures that are not a PNG image', async () => {
  for (const bytes of [
    Buffer.from('not a png at all'),
    pngHeader(100, 100, {magic: false}),
    pngHeader(100, 100, {ihdr: false}),
    pngHeader(0, 100),
  ]) {
    const {exec, calls} = fakeRunner(bytes);
    await assert.rejects(captureGameWindow({}, windowsDeps(exec)), /visual_capture_invalid_png/);
    assert.equal(fs.existsSync(path.dirname(capturePathFrom(calls[0].args))), false, 'invalid captures must still be cleaned up');
  }
});

test('rejects hostile window titles before spawning anything', async () => {
  let called = false;
  const exec = async () => { called = true; return {stdout: '', stderr: ''}; };
  for (const title of ['bad\nwindow', 'bad\u0000window', '-Focus', 'x'.repeat(201)]) {
    await assert.rejects(captureGameWindow({title}, windowsDeps(exec)), /invalid_capture_title/);
  }
  assert.equal(called, false);
});

test('reports a missing capture script before spawning anything', async () => {
  let called = false;
  const missing = path.join(os.tmpdir(), 'autorio-missing-capture-script.ps1');
  await assert.rejects(
    captureGameWindow({}, {platform: 'win32', scriptPath: missing, exec: async () => { called = true; return {stdout: '', stderr: ''}; }}),
    /visual_capture_missing_script/,
  );
  assert.equal(called, false);
});

// The route is a one-line wrapper: json(res, 200, await visualObservation(body)).
// Asserting the payload here covers the contract without importing dist/server.js,
// whose module import starts the manager HTTP server and claims .autorio.
test('exposes the POST /api/agent/observe/visual {ok, data} response contract', async () => {
  const bytes = pngHeader(800, 600);
  const {exec} = fakeRunner(bytes);
  const response = await visualObservation({}, windowsDeps(exec));
  assert.deepEqual(Object.keys(response), ['ok', 'data']);
  assert.equal(response.ok, true);
  assert.deepEqual(Object.keys(response.data).sort(), ['base64', 'format', 'height', 'source', 'width']);
  assert.equal(response.data.format, 'png');
  assert.equal(response.data.source, 'window');
  assert.equal(response.data.width, 800);
  assert.equal(response.data.height, 600);
  assert.deepEqual(Buffer.from(JSON.parse(JSON.stringify(response)).data.base64, 'base64'), bytes);

  await assert.rejects(visualObservation({}, {platform: 'linux'}), /visual_capture_unsupported_platform/);
});
